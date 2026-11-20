import fs from "node:fs/promises";
import { Octokit, RequestError } from "octokit";
import {
  Asset,
  distributionReleaseName,
  distributionRepo,
  rootLogger,
  splitRepoName,
} from "./common.ts";
import { Release, ReleaseData, TargetRepoKey } from "./constants.ts";

export type ReleaseSource = Omit<ReleaseData, "files">;

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
    data: await fs.readFile(filePath),
  });
  return response.data;
}

export async function deleteReleaseAsset(asset: Asset): Promise<void> {
  await releaseClient.rest.repos.deleteReleaseAsset({
    ...splitRepoName(distributionRepo),
    asset_id: asset.id,
  });
}
