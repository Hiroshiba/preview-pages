import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Semaphore } from "@core/asyncutil";
import { Logger } from "@logtape/logtape";
import { Octokit, RequestError } from "octokit";
import unzip from "unzip-stream";
import {
  Asset,
  cacheDownloadDir,
  destinationDir,
  distributionReleaseName,
  distributionRepo,
  rootLogger,
  splitRepoName,
} from "./common.ts";
import { Release, ReleaseData, TargetRepoKey } from "./constants.ts";
import {
  fetchArtifactBody,
  fetchArtifactDownloadUrl,
  ReleaseArtifact,
} from "./artifact.ts";

export type ReleaseSource = Omit<ReleaseData, "files">;

export type ReleaseSelection = {
  source: ReleaseSource;
  artifacts: ReleaseArtifact[];
};

type ReleaseFile = ReleaseData["files"][number];

const log = rootLogger.getChild("release");

const releaseClient = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export function createReleaseBranchPrefix(
  repoKey: TargetRepoKey,
  branch: string,
): string {
  return `${repoKey}-branch-${branch}-`;
}

export function createReleaseRunPrefix(source: ReleaseSource): string {
  return `${createReleaseBranchPrefix(source.repoKey, source.branch)}${source.runId}-`;
}

export function createReleaseFileName(
  source: ReleaseSource,
  name: string,
): string {
  return `${createReleaseRunPrefix(source)}${name}`;
}

export function createReleaseInfoFileName(source: ReleaseSource): string {
  return `${createReleaseRunPrefix(source)}v1.json`;
}

export async function getDistributionRelease(): Promise<Release | undefined> {
  try {
    const response = await releaseClient.rest.repos.getReleaseByTag({
      ...splitRepoName(distributionRepo),
      tag: distributionReleaseName,
    });
    return response.data;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

export async function createDistributionReleaseIfNotExists(): Promise<Release> {
  log.info`Checking if release ${distributionReleaseName} exists...`;
  const existingRelease = await getDistributionRelease();
  if (existingRelease != undefined) {
    log.info`Release ${distributionReleaseName} already exists.`;
    return existingRelease;
  }

  log.info`Creating release ${distributionReleaseName}...`;
  const response = await releaseClient.rest.repos.createRelease({
    ...splitRepoName(distributionRepo),
    tag_name: distributionReleaseName,
    name: "Preview Pages Release",
    body: "preview-pagesの開発版を配布するリリース。手動で編集しないでください。",
    prerelease: true,
  });
  log.info`Release ${distributionReleaseName} created.`;
  return response.data;
}

export async function uploadReleaseAsset(
  release: Release,
  name: string,
  filePath: string,
): Promise<Asset> {
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing != undefined) {
    if (existing.state === "uploaded") {
      log.info`Asset ${name} already exists, skipping upload.`;
      return existing;
    }
    await deleteReleaseAsset(existing);
  }

  log.info`Uploading ${name}...`;
  const response = await releaseClient.rest.repos.uploadReleaseAsset({
    ...splitRepoName(distributionRepo),
    release_id: release.id,
    name,
    // 指定しないとapplication/jsonとして保存される
    headers: { "content-type": "application/octet-stream" },
    // @ts-expect-error octokitの型定義が間違っている。 https://github.com/octokit/octokit.js/discussions/2087
    data: await fsSync.openAsBlob(filePath),
  });
  return response.data;
}

export async function deleteReleaseAsset(asset: Asset): Promise<void> {
  await releaseClient.rest.repos.deleteReleaseAsset({
    ...splitRepoName(distributionRepo),
    asset_id: asset.id,
  });
}

export async function processAllReleases(
  processRelease: (
    log: Logger,
    releaseSelection: ReleaseSelection,
  ) => Promise<ReleaseData>,
): Promise<void> {
  const releaseSelections = JSON.parse(
    await fs.readFile(`${cacheDownloadDir}/releaseSelections.json`, "utf-8"),
  ) as ReleaseSelection[];

  const releases: ReleaseData[] = [];
  for (const releaseSelection of releaseSelections) {
    const { repoKey, branch } = releaseSelection.source;
    const releaseLog = rootLogger
      .getChild(repoKey)
      .getChild(`Branch ${branch}`);
    try {
      releases.push(await processRelease(releaseLog, releaseSelection));
      releaseLog.info("Done.");
    } catch (e) {
      releaseLog.error`Failed to process: ${e}`;
    }
  }

  await fs.writeFile(
    `${destinationDir}/releases.json`,
    JSON.stringify(releases, null, 2),
  );
  rootLogger.info`Releases: ${releases.length} successful / ${releaseSelections.length} targets`;
}

const releaseArtifactSemaphore = new Semaphore(5);
export async function transferReleaseFiles(
  releaseLog: Logger,
  { source, artifacts }: ReleaseSelection,
  transferFile: (name: string, content: Readable) => Promise<ReleaseFile>,
): Promise<ReleaseFile[]> {
  if (artifacts.length === 0) {
    throw new Error(`No release artifacts found in run ${source.runId}`);
  }

  const fileNames = new Set<string>();
  const filesByArtifact: ReleaseFile[][] = artifacts.map(() => []);
  let failed = false;
  const results = await Promise.allSettled(
    artifacts.map((artifact, index) =>
      releaseArtifactSemaphore.lock(async () => {
        if (failed) {
          return;
        }
        try {
          const url = await fetchArtifactDownloadUrl(
            releaseLog,
            source.repoKey,
            artifact,
          );
          await forEachZipEntry(await fetchArtifactBody(url), async (entry) => {
            if (entry.type === "Directory") {
              entry.autodrain();
              return;
            }
            const name = path.posix.basename(entry.path);
            if (fileNames.has(name)) {
              throw new Error(`Duplicate release file name: ${name}`);
            }
            fileNames.add(name);
            filesByArtifact[index].push(await transferFile(name, entry));
          });
        } catch (e) {
          failed = true;
          throw e;
        }
      }),
    ),
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected != undefined) {
    throw rejected.reason;
  }
  return filesByArtifact.flat();
}

async function forEachZipEntry(
  zip: Readable,
  processEntry: (entry: unzip.Entry) => Promise<void>,
): Promise<void> {
  await pipeline(
    zip,
    unzip.Parse(),
    new Writable({
      objectMode: true,
      write(entry: unzip.Entry, _encoding, callback) {
        void processEntry(entry).then(() => callback(), callback);
      },
    }),
  );
}
