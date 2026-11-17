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
import { ReleaseData, releaseTargets, ReleaseTargetKey } from "./constants.ts";
import {
  Asset,
  createRelease,
  ensureReleaseAsset,
  getRelease,
  publishRelease,
} from "./release.ts";

export type ReleaseSource = {
  key: ReleaseTargetKey;
  commitSha: string;
  runId: number;
};

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
    throw new Error(`No job found for ${target.repo} ${target.branch}`);
  }
  if (!(await waitForJobCompletion(log, jobAndRunId.jobId, target.repo))) {
    throw new Error(`Job #${jobAndRunId.jobId} did not complete successfully`);
  }
  return { key, commitSha, runId: jobAndRunId.runId };
}

/** 選択したrunの配布用Artifactを取得できるか確認する。 */
export async function checkReleaseArtifacts(
  log: Logger,
  source: ReleaseSource,
): Promise<void> {
  const target = releaseTargets[source.key];
  const artifacts = await fetchReleaseArtifacts(target.repo, source.runId);
  for (const artifact of artifacts) {
    await fetchArtifactDownloadUrl(log, target.repo, artifact);
    log.info`Download skipped: ${artifact.name}`;
  }
}

/** 選択したrunの配布ファイルをReleaseへ保存する。 */
export async function collectRelease(
  log: Logger,
  source: ReleaseSource,
): Promise<ReleaseData> {
  const target = releaseTargets[source.key];
  const existingRelease = await getRelease(source.key, source.runId);
  if (existingRelease != undefined && !existingRelease.draft) {
    return toReleaseData(source, existingRelease.assets);
  }

  const artifacts = await fetchReleaseArtifacts(target.repo, source.runId);
  const release =
    existingRelease ??
    (await createRelease(source.key, source.runId, source.commitSha));
  const assets: Asset[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "preview-release-"));
  try {
    const filePath = path.join(tempDir, "entry");
    for (const artifact of artifacts) {
      const url = await fetchArtifactDownloadUrl(log, target.repo, artifact);
      await forEachZipEntry(url, async (entry) => {
        if (entry.type === "Directory") {
          entry.autodrain();
          return;
        }
        const name = path.posix.basename(entry.path);
        if (assets.some((asset) => asset.name === name)) {
          throw new Error(`Duplicate release file name: ${name}`);
        }
        await pipeline(entry, fsSync.createWriteStream(filePath));
        assets.push(await ensureReleaseAsset(release, name, filePath));
      });
    }
    await publishRelease(release);
    return toReleaseData(source, assets);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function toReleaseData(source: ReleaseSource, assets: Asset[]): ReleaseData {
  return {
    key: source.key,
    branch: releaseTargets[source.key].branch,
    commitSha: source.commitSha,
    runId: source.runId,
    files: assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
    })),
  };
}

async function forEachZipEntry(
  url: string,
  processEntry: (entry: unzip.Entry) => Promise<void>,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download artifact: ${response.status} ${response.statusText}`,
    );
  }
  if (response.body == null) {
    throw new Error("Response body is empty");
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
