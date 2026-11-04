import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import unzip from "unzip-stream";
import {
  fetchArtifactUrl,
  getJobAndRunId,
  waitForJobCompletion,
} from "./artifactSource.ts";
import {
  artifactName,
  octokit,
  rootLogger,
  splitRepoName,
  UnreachableError,
} from "./common.ts";
import { engineBranch, engineRepo, engineTargets } from "./constants.ts";
import {
  EngineDownloads,
  EngineIndex,
  EngineManifest,
  engineManifestSchema,
} from "./engineDownloadSchema.ts";
import {
  createEngineRelease,
  ensureEngineAsset,
  getEngineRelease,
  listEngineAssets,
  publishEngineRelease,
  readEngineDownloads,
} from "./engineRelease.ts";

const log = rootLogger.getChild("engine");
const unavailable: EngineDownloads = { status: "unavailable" };

/** ENGINE masterの開発版を収集し、Releaseのリンク一覧を返す。 */
export async function collectEngine(
  fetchUrlOnly: boolean,
): Promise<{ downloads: EngineDownloads; collected: boolean }> {
  try {
    const branchResponse = await octokit.rest.repos.getBranch({
      ...splitRepoName(engineRepo),
      branch: engineBranch,
    });
    const commitSha = branchResponse.data.commit.sha;
    const jobAndRunId = await getJobAndRunId(log, engineRepo, engineBranch);
    if (jobAndRunId == undefined) {
      throw new Error("ENGINEのプレビュー用jobがありません");
    }
    const { jobId, runId } = jobAndRunId;
    if (!(await waitForJobCompletion(log, jobId, engineRepo))) {
      throw new Error(`ENGINEのプレビュー用jobが成功していません: ${jobId}`);
    }

    if (fetchUrlOnly) {
      const url = await fetchArtifactUrl(log, engineRepo, runId, artifactName);
      if (url == undefined) {
        throw new Error(`ENGINEのmanifest Artifactを取得できません: ${runId}`);
      }
      log.info`Download skipped: ${url}`;
      return { downloads: unavailable, collected: true };
    }

    const existingRelease = await getEngineRelease(runId);
    if (existingRelease != undefined) {
      const downloads = await readEngineDownloads(
        existingRelease,
        runId,
        commitSha,
      );
      if (downloads != undefined) {
        return { downloads, collected: true };
      }
    }

    const manifestUrl = await fetchArtifactUrl(
      log,
      engineRepo,
      runId,
      artifactName,
    );
    if (manifestUrl == undefined) {
      throw new Error(`ENGINEのmanifest Artifactを取得できません: ${runId}`);
    }
    const manifest = await readManifest(manifestUrl);
    if (manifest.runId !== runId || manifest.commitSha !== commitSha) {
      throw new Error(`ENGINEのmanifestがrunとcommitに一致しません: ${runId}`);
    }
    const release = existingRelease ?? (await createEngineRelease(runId));
    const assets = new Map(
      (await listEngineAssets(release)).map((asset) => [asset.name, asset]),
    );
    const index: EngineIndex = {
      runId,
      commitSha,
      version: manifest.version,
      targets: [],
    };
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preview-engine-"));
    try {
      for (const target of engineTargets) {
        const item = manifest.targets.find((entry) => entry.target === target);
        if (item == undefined) {
          throw new UnreachableError();
        }
        const sevenZip = await collectFormat(
          runId,
          item,
          "sevenZip",
          release,
          assets,
          tempDir,
        );
        const vvpp = await collectFormat(
          runId,
          item,
          "vvpp",
          release,
          assets,
          tempDir,
        );
        index.targets.push({ target, sevenZip, vvpp });
      }
      const indexPath = path.join(tempDir, "index.json");
      await fs.writeFile(indexPath, JSON.stringify(index));
      const downloads = await publishEngineRelease(
        release,
        assets,
        index,
        indexPath,
      );
      return { downloads, collected: true };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    log.error`Failed to process: ${error}`;
    return { downloads: unavailable, collected: false };
  }
}

async function readManifest(url: string): Promise<EngineManifest> {
  let manifestText: string | undefined;
  await forEachZipEntry(url, async (entry) => {
    if (
      entry.type !== "File" ||
      entry.path !== "engine-download-manifest.json" ||
      manifestText != undefined
    ) {
      throw new Error(
        `ENGINEのmanifest ZIPに想定外のentryがあります: ${entry.path}`,
      );
    }
    entry.setEncoding("utf8");
    let text = "";
    for await (const chunk of entry) {
      if (typeof chunk !== "string") {
        throw new UnreachableError();
      }
      text += chunk;
    }
    manifestText = text;
  });
  if (manifestText == undefined) {
    throw new Error("ENGINEのmanifest ZIPが空です");
  }
  return engineManifestSchema.parse(JSON.parse(manifestText));
}

type Format = "sevenZip" | "vvpp";
type FormatFiles = EngineIndex["targets"][number]["sevenZip"];
type Release = Awaited<ReturnType<typeof createEngineRelease>>;
type Asset = Awaited<ReturnType<typeof listEngineAssets>>[number];

async function collectFormat(
  runId: number,
  item: EngineManifest["targets"][number],
  format: Format,
  release: Release,
  assets: Map<string, Asset>,
  tempDir: string,
): Promise<FormatFiles> {
  const artifact =
    format === "sevenZip" ? item.sevenZipArtifact : item.vvppArtifact;
  const url = await fetchArtifactUrl(log, engineRepo, runId, artifact);
  if (url == undefined) {
    throw new Error(`ENGINEのformat Artifactを取得できません: ${artifact}`);
  }
  const prefix = artifact.slice(0, format === "sevenZip" ? -3 : -5);
  const listName = `${prefix}.${format === "sevenZip" ? "7z" : "vvpp"}.txt`;
  const names = new Set<string>();
  let listText: string | undefined;
  const filePath = path.join(tempDir, "entry");
  await forEachZipEntry(url, async (entry) => {
    const name = entry.path;
    if (
      entry.type !== "File" ||
      !isFormatFile(name, prefix, format, listName) ||
      names.has(name)
    ) {
      throw new Error(`ENGINEのformat ZIPに想定外のentryがあります: ${name}`);
    }
    names.add(name);
    try {
      await pipeline(entry, fsSync.createWriteStream(filePath));
      if (name === listName) {
        listText = await fs.readFile(filePath, "utf8");
      }
      await ensureEngineAsset(release, assets, name, filePath);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });
  if (listText == undefined) {
    throw new Error(`ENGINEの一覧ファイルがありません: ${listName}`);
  }
  const parts = listText.split(/\r?\n/).filter((line) => line !== "");
  if (
    parts.length === 0 ||
    new Set(parts).size !== parts.length ||
    parts.length !== names.size - 1 ||
    parts.some((name) => name === listName || !names.has(name))
  ) {
    throw new Error(
      `ENGINEの一覧とformat ZIPのentryが一致しません: ${artifact}`,
    );
  }
  if (
    format === "vvpp" &&
    parts.some((name) => name.endsWith(".vvpp")) &&
    parts.length !== 1
  ) {
    throw new Error(`ENGINEのVVPP形式が混在しています: ${artifact}`);
  }
  return { list: listName, parts };
}

function isFormatFile(
  name: string,
  prefix: string,
  format: Format,
  listName: string,
): boolean {
  if (name === listName) {
    return true;
  }
  if (format === "sevenZip") {
    return (
      name.startsWith(`${prefix}.7z.`) &&
      /^\d{3}$/.test(name.slice(`${prefix}.7z.`.length))
    );
  }
  return (
    name === `${prefix}.vvpp` ||
    (name.startsWith(`${prefix}.`) &&
      /^\d{3}\.vvppp$/.test(name.slice(`${prefix}.`.length)))
  );
}

async function forEachZipEntry(
  url: string,
  processEntry: (entry: unzip.Entry) => Promise<void>,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ENGINEのArtifactをdownloadできません: ${response.status}`);
  }
  if (response.body == null) {
    throw new Error("ENGINEのArtifact応答に本文がありません");
  }
  await pipeline(
    Readable.fromWeb(response.body),
    unzip.Parse(),
    new Writable({
      objectMode: true,
      write(entry: unzip.Entry, _encoding, callback) {
        void processEntry(entry).then(() => callback(), callback);
      },
    }),
  );
}
