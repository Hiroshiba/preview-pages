import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Logger } from "@logtape/logtape";
import unzip from "unzip-stream";
import {
  fetchArtifactDownloadUrl,
  fetchReleaseArtifacts,
  getJobAndRunIdForBranch,
  waitForJobCompletion,
} from "./artifactSource.ts";
import { releaseTargets, ReleaseTargetKey } from "./constants.ts";
import {
  createRelease,
  ensureReleaseAsset,
  getRelease,
  listReleaseAssets,
  publishRelease,
  readPublishedRelease,
} from "./release.ts";
import { ReleaseData, releaseFileNameSchema } from "./releaseSchema.ts";

type ReleaseSource = { branch: string; commitSha: string; runId: number };

/** 配布対象のcommitとbranchに一致する成功runを一度選ぶ。 */
export async function selectReleaseSource(
  log: Logger,
  key: ReleaseTargetKey,
  commitSha: string,
): Promise<ReleaseSource> {
  const target = releaseTargets[key];
  const jobAndRunId = await getJobAndRunIdForBranch(
    log,
    target.repo,
    target.branch,
    commitSha,
  );
  if (jobAndRunId == undefined) {
    throw new Error(
      `配布対象のプレビュー用jobがありません: ${target.repo} ${target.branch}`,
    );
  }
  if (!(await waitForJobCompletion(log, jobAndRunId.jobId, target.repo))) {
    throw new Error(
      `配布対象のプレビュー用jobが成功していません: ${jobAndRunId.jobId}`,
    );
  }
  return { branch: target.branch, commitSha, runId: jobAndRunId.runId };
}

/** 選択したrunの配布ファイルをReleaseへ保存する。 */
export async function collectRelease(
  log: Logger,
  key: ReleaseTargetKey,
  source: ReleaseSource,
  fetchUrlOnly: boolean,
): Promise<ReleaseData> {
  const target = releaseTargets[key];
  if (fetchUrlOnly) {
    const artifacts = await fetchReleaseArtifacts(target.repo, source.runId);
    for (const artifact of artifacts) {
      const url = await fetchArtifactDownloadUrl(log, target.repo, artifact);
      if (url == undefined) {
        throw new Error(`Failed to fetch artifact URL: ${artifact.name}`);
      }
      log.info`Download skipped: ${artifact.name}`;
    }
    return { status: "unavailable" };
  }

  const existingRelease = await getRelease(key, source.runId);
  if (existingRelease != undefined) {
    const published = await readPublishedRelease(
      existingRelease,
      source.branch,
      source.commitSha,
      source.runId,
    );
    if (published != undefined) {
      return published;
    }
  }

  const artifacts = await fetchReleaseArtifacts(target.repo, source.runId);
  const release =
    existingRelease ??
    (await createRelease(key, source.runId, source.commitSha));
  const listedAssets = await listReleaseAssets(release);
  const assets = new Map(listedAssets.map((asset) => [asset.name, asset]));
  if (assets.size !== listedAssets.length) {
    throw new Error(`Release assetの名前が重複しています: ${release.tag_name}`);
  }
  const expected = new Map<string, number>();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preview-release-"));
  try {
    const filePath = path.join(tempDir, "entry");
    for (const artifact of artifacts) {
      const url = await fetchArtifactDownloadUrl(log, target.repo, artifact);
      if (url == undefined) {
        throw new Error(`Failed to fetch artifact URL: ${artifact.name}`);
      }
      await forEachZipEntry(url, async (entry) => {
        if (entry.type === "Directory") {
          entry.autodrain();
          return;
        }
        const name = releaseFileNameSchema.parse(
          path.posix.basename(entry.path),
        );
        if (expected.has(name)) {
          throw new Error(`配布ファイル名が重複しています: ${name}`);
        }
        try {
          await pipeline(entry, fsSync.createWriteStream(filePath));
          const size = await ensureReleaseAsset(
            release,
            assets,
            name,
            filePath,
          );
          expected.set(name, size);
        } finally {
          await fs.rm(filePath, { force: true });
        }
      });
    }
    return await publishRelease(
      release,
      source.branch,
      source.commitSha,
      source.runId,
      expected,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function forEachZipEntry(
  url: string,
  processEntry: (entry: unzip.Entry) => Promise<void>,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`配布Artifactを取得できません: ${response.status}`);
  }
  if (response.body == null) {
    throw new Error("配布Artifactの応答に本文がありません");
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
