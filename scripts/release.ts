import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Endpoints } from "@octokit/types";
import { Octokit } from "octokit";
import { cacheRepo, splitRepoName } from "./common.ts";
import { releaseTargets, ReleaseTargetKey } from "./constants.ts";

type Release =
  Endpoints["GET /repos/{owner}/{repo}/releases/{release_id}"]["response"]["data"];
export type Asset =
  Endpoints["GET /repos/{owner}/{repo}/releases/assets/{asset_id}"]["response"]["data"];

const releaseClient = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

/** 配布対象のRelease tagの接頭辞を生成する。 */
export function getReleaseTagPrefix(key: ReleaseTargetKey): string {
  return `preview-pages-download-${key}-run-`;
}

/** 配布対象とrunからRelease tagを生成する。 */
export function getReleaseTag(key: ReleaseTargetKey, runId: number): string {
  return `${getReleaseTagPrefix(key)}${runId}`;
}

/** draftを含むすべてのReleaseを取得する。 */
export async function listReleases(): Promise<Release[]> {
  return releaseClient.paginate("GET /repos/{owner}/{repo}/releases", {
    ...splitRepoName(cacheRepo),
    per_page: 100,
  });
}

/** 指定runのReleaseを取得する。 */
export async function getRelease(
  key: ReleaseTargetKey,
  runId: number,
): Promise<Release | undefined> {
  const releases = await listReleases();
  return releases.find(
    (release) => release.tag_name === getReleaseTag(key, runId),
  );
}

/** 指定runのdraft Releaseを作成する。 */
export async function createRelease(
  key: ReleaseTargetKey,
  runId: number,
  commitSha: string,
): Promise<Release> {
  const target = releaseTargets[key];
  const response = await releaseClient.rest.repos.createRelease({
    ...splitRepoName(cacheRepo),
    tag_name: getReleaseTag(key, runId),
    target_commitish: process.env.GITHUB_SHA,
    name: `${target.label} ${target.branch} run ${runId}`,
    body: `${target.repo} の ${target.branch}、${commitSha} の配布ファイルです。`,
    draft: true,
    prerelease: true,
    request: { retries: 0 },
  });
  return response.data;
}

/** upload済みで同じサイズの同名assetは再利用し、それ以外は削除してからstreamでuploadする。 */
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

/** draft Releaseを公開する。 */
export async function publishRelease(release: Release): Promise<void> {
  await releaseClient.rest.repos.updateRelease({
    ...splitRepoName(cacheRepo),
    release_id: release.id,
    draft: false,
  });
}
