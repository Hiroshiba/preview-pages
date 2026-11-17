import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Octokit } from "octokit";
import { Asset, cacheRepo, splitRepoName } from "./common.ts";
import {
  Release,
  ReleaseData,
  TargetRepoKey,
  targetRepos,
} from "./constants.ts";

export type ReleaseSource = Omit<ReleaseData, "files">;

const releaseClient = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export function getReleaseTagPrefix(repoKey: TargetRepoKey): string {
  return `preview-pages-release-${repoKey}-run-`;
}

export function getReleaseTag(repoKey: TargetRepoKey, runId: number): string {
  return `${getReleaseTagPrefix(repoKey)}${runId}`;
}

export async function listReleases(): Promise<Release[]> {
  return releaseClient.paginate("GET /repos/{owner}/{repo}/releases", {
    ...splitRepoName(cacheRepo),
    per_page: 100,
  });
}

export async function getRelease(
  repoKey: TargetRepoKey,
  runId: number,
): Promise<Release | undefined> {
  const releases = await listReleases();
  return releases.find(
    (release) => release.tag_name === getReleaseTag(repoKey, runId),
  );
}

export async function createRelease(source: ReleaseSource): Promise<Release> {
  const target = targetRepos[source.repoKey];
  const response = await releaseClient.rest.repos.createRelease({
    ...splitRepoName(cacheRepo),
    tag_name: getReleaseTag(source.repoKey, source.runId),
    name: `${target.label} ${source.branch} run ${source.runId}`,
    body: `${target.repo} の ${source.branch}、${source.commitSha} の配布ファイルです。`,
    draft: true,
    prerelease: true,
  });
  return response.data;
}

export async function ensureReleaseAsset(
  release: Release,
  name: string,
  filePath: string,
): Promise<Asset> {
  const size = (await fs.stat(filePath)).size;
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing != undefined) {
    if (existing.state === "uploaded" && existing.size === size) {
      return existing;
    }
    await releaseClient.rest.repos.deleteReleaseAsset({
      ...splitRepoName(cacheRepo),
      asset_id: existing.id,
    });
  }

  const response = await releaseClient.rest.repos.uploadReleaseAsset({
    ...splitRepoName(cacheRepo),
    release_id: release.id,
    name,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": size,
    },
    request: { retries: 0 },
    // @ts-expect-error Octokitの型定義はstreamを受け付けない
    data: fsSync.createReadStream(filePath),
  });
  return response.data;
}

export async function publishRelease(release: Release): Promise<void> {
  await releaseClient.rest.repos.updateRelease({
    ...splitRepoName(cacheRepo),
    release_id: release.id,
    draft: false,
  });
}

export async function deleteRelease(release: Release): Promise<void> {
  if (!release.draft) {
    await releaseClient.rest.git.deleteRef({
      ...splitRepoName(cacheRepo),
      ref: `tags/${release.tag_name}`,
    });
  }
  await releaseClient.rest.repos.deleteRelease({
    ...splitRepoName(cacheRepo),
    release_id: release.id,
  });
}
