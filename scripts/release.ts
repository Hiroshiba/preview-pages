import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Transform } from "node:stream";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { Endpoints } from "@octokit/types";
import { Octokit } from "octokit";
import { cacheRepo, splitRepoName } from "./common.ts";
import { releaseTargets, ReleaseTargetKey } from "./constants.ts";
import { AvailableRelease, releaseFileNameSchema } from "./releaseSchema.ts";

type Release =
  Endpoints["GET /repos/{owner}/{repo}/releases/{release_id}"]["response"]["data"];
type Asset =
  Endpoints["GET /repos/{owner}/{repo}/releases/assets/{asset_id}"]["response"]["data"];

const releaseClient = new (Octokit.plugin(paginateRest))({
  auth: process.env.GITHUB_TOKEN,
});

/** 配布対象とrunからRelease tagを生成する。 */
export function getReleaseTag(key: ReleaseTargetKey, runId: number): string {
  return `preview-pages-download-${key}-run-${runId}`;
}

/** 指定runのReleaseを取得する。 */
export async function getRelease(
  key: ReleaseTargetKey,
  runId: number,
): Promise<Release | undefined> {
  const releases = await releaseClient.paginate(
    "GET /repos/{owner}/{repo}/releases",
    { ...splitRepoName(cacheRepo), per_page: 100 },
  );
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

/** Releaseの全assetを再取得する。 */
export async function listReleaseAssets(release: Release): Promise<Asset[]> {
  return releaseClient.paginate(
    "GET /repos/{owner}/{repo}/releases/{release_id}/assets",
    {
      ...splitRepoName(cacheRepo),
      release_id: release.id,
      per_page: 100,
    },
  );
}

/** 同名assetをサイズ照合して再利用し、存在しなければstreamでuploadする。 */
export async function ensureReleaseAsset(
  release: Release,
  assets: Map<string, Asset>,
  name: string,
  filePath: string,
): Promise<number> {
  const size = (await fs.stat(filePath)).size;
  if (size >= 2_147_483_648) {
    throw new Error(`Release assetの上限を超えています: ${name}`);
  }
  const existing = assets.get(name);
  if (existing != undefined) {
    if (existing.state !== "uploaded" || existing.size !== size) {
      throw new Error(`Release assetが元ファイルと一致しません: ${name}`);
    }
    return size;
  }

  let uploadedBytes = 0;
  const input = fsSync.createReadStream(filePath);
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      uploadedBytes += chunk.length;
      callback(null, chunk);
    },
  });
  input.pipe(counted);
  try {
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
      data: counted,
    });
    const asset = response.data;
    if (
      uploadedBytes !== size ||
      asset.name !== name ||
      asset.state !== "uploaded" ||
      asset.size !== size
    ) {
      throw new Error(`Release assetのupload結果が一致しません: ${name}`);
    }
    assets.set(name, asset);
    return size;
  } finally {
    input.destroy();
    counted.destroy();
  }
}

function buildReleaseData(
  release: Release,
  branch: string,
  commitSha: string,
  runId: number,
  assets: Asset[],
): AvailableRelease {
  if (assets.length === 0) {
    throw new Error(`Releaseに配布ファイルがありません: ${release.tag_name}`);
  }
  const names = new Set<string>();
  const files = assets.map((asset) => {
    const name = releaseFileNameSchema.parse(asset.name);
    if (names.has(name) || asset.state !== "uploaded") {
      throw new Error(`Release assetが重複または未完了です: ${name}`);
    }
    names.add(name);
    return { name, size: asset.size, url: asset.browser_download_url };
  });
  return {
    status: "available",
    branch,
    commitSha,
    runId,
    files,
  };
}

/** 公開済みReleaseのasset一覧から配布ファイルを復元する。 */
export async function readPublishedRelease(
  release: Release,
  branch: string,
  commitSha: string,
  runId: number,
): Promise<AvailableRelease | undefined> {
  if (release.draft) {
    return;
  }
  return buildReleaseData(
    release,
    branch,
    commitSha,
    runId,
    await listReleaseAssets(release),
  );
}

/** 全assetの名前、状態、サイズを確認してReleaseを公開する。 */
export async function publishRelease(
  release: Release,
  branch: string,
  commitSha: string,
  runId: number,
  expected: Map<string, number>,
): Promise<AvailableRelease> {
  const assets = await listReleaseAssets(release);
  if (assets.length !== expected.size) {
    throw new Error(`Release assetの件数が一致しません: ${release.tag_name}`);
  }
  const data = buildReleaseData(release, branch, commitSha, runId, assets);
  for (const file of data.files) {
    if (expected.get(file.name) !== file.size) {
      throw new Error(`Release assetが元ファイルと一致しません: ${file.name}`);
    }
  }
  await releaseClient.rest.repos.updateRelease({
    ...splitRepoName(cacheRepo),
    release_id: release.id,
    draft: false,
    prerelease: true,
    request: { retries: 0 },
  });
  return data;
}
