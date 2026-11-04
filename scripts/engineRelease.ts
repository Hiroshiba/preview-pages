import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Transform } from "node:stream";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { Endpoints } from "@octokit/types";
import { Octokit, RequestError } from "octokit";
import { cacheRepo, splitRepoName, UnreachableError } from "./common.ts";
import { engineTargets } from "./constants.ts";
import {
  EngineDownloads,
  EngineIndex,
  engineIndexSchema,
} from "./engineDownloadSchema.ts";

type Release =
  Endpoints["GET /repos/{owner}/{repo}/releases/{release_id}"]["response"]["data"];
type Asset =
  Endpoints["GET /repos/{owner}/{repo}/releases/assets/{asset_id}"]["response"]["data"];

const indexName = "engine-download-index.json";
const releaseClient = new (Octokit.plugin(paginateRest))({
  auth: process.env.GITHUB_TOKEN,
});

/** ENGINE runのReleaseを取得する。 */
export async function getEngineRelease(
  runId: number,
): Promise<Release | undefined> {
  try {
    const response = await releaseClient.rest.repos.getReleaseByTag({
      ...splitRepoName(cacheRepo),
      tag: `engine-master-run-${runId}`,
    });
    return response.data;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      return;
    }
    throw error;
  }
}

/** ENGINE runのdraft Releaseを作成する。 */
export async function createEngineRelease(runId: number): Promise<Release> {
  const response = await releaseClient.rest.repos.createRelease({
    ...splitRepoName(cacheRepo),
    tag_name: `engine-master-run-${runId}`,
    target_commitish: process.env.GITHUB_SHA,
    name: `VOICEVOX ENGINE master run ${runId}`,
    body: "VOICEVOX ENGINEのmaster開発版を保存するリリースです。",
    draft: true,
    prerelease: true,
    request: { retries: 0 },
  });
  return response.data;
}

/** Releaseの全assetを再取得する。 */
export async function listEngineAssets(release: Release): Promise<Asset[]> {
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
export async function ensureEngineAsset(
  release: Release,
  assets: Map<string, Asset>,
  name: string,
  filePath: string,
): Promise<void> {
  const size = (await fs.stat(filePath)).size;
  if (size >= 2_147_483_648) {
    throw new Error(`Release assetの上限を超えています: ${name}`);
  }
  const existing = assets.get(name);
  if (existing != undefined) {
    if (existing.state !== "uploaded" || existing.size !== size) {
      throw new Error(`Release assetが元ファイルと一致しません: ${name}`);
    }
    return;
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
  } finally {
    input.destroy();
    counted.destroy();
  }
}

/** indexを最後に保存し、全assetを検査してReleaseを公開する。 */
export async function publishEngineRelease(
  release: Release,
  assets: Map<string, Asset>,
  index: EngineIndex,
  indexPath: string,
): Promise<EngineDownloads> {
  await ensureEngineAsset(release, assets, indexName, indexPath);
  const completeAssets = await listEngineAssets(release);
  const downloads = buildEngineDownloads(release, index, completeAssets);
  await releaseClient.rest.repos.updateRelease({
    ...splitRepoName(cacheRepo),
    release_id: release.id,
    draft: false,
    prerelease: true,
  });
  return downloads;
}

/** 公開済みReleaseのindexとassetを検査してPages一覧を復元する。 */
export async function readEngineDownloads(
  release: Release,
  runId: number,
  commitSha: string,
): Promise<EngineDownloads | undefined> {
  if (release.draft) {
    return;
  }
  const assets = await listEngineAssets(release);
  const indexAsset = assets.find((asset) => asset.name === indexName);
  if (indexAsset == undefined) {
    throw new Error(`ENGINE Releaseのindexがありません: ${runId}`);
  }
  const response = await fetch(indexAsset.browser_download_url);
  if (!response.ok) {
    throw new Error(
      `ENGINE Releaseのindexを取得できません: ${response.status}`,
    );
  }
  const index = engineIndexSchema.parse(await response.json());
  if (index.runId !== runId || index.commitSha !== commitSha) {
    throw new Error(`ENGINE Releaseのindexがrunと一致しません: ${runId}`);
  }
  return buildEngineDownloads(release, index, assets);
}

function buildEngineDownloads(
  release: Release,
  index: EngineIndex,
  assets: Asset[],
): EngineDownloads {
  const expected = new Set([indexName]);
  for (const target of index.targets) {
    for (const format of [target.sevenZip, target.vvpp]) {
      for (const name of [format.list, ...format.parts]) {
        if (expected.has(name)) {
          throw new Error(
            `ENGINE Releaseのファイル名が重複しています: ${name}`,
          );
        }
        expected.add(name);
      }
    }
  }
  const assetsByName = new Map(assets.map((asset) => [asset.name, asset]));
  if (assetsByName.size !== expected.size || assets.length !== expected.size) {
    throw new Error("ENGINE Releaseのasset一覧がindexと一致しません");
  }
  for (const name of expected) {
    const asset = assetsByName.get(name);
    if (asset == undefined || asset.state !== "uploaded") {
      throw new Error(`ENGINE Releaseのassetが不足しています: ${name}`);
    }
  }

  return {
    status: "available",
    runId: index.runId,
    commitSha: index.commitSha,
    version: index.version,
    releaseUrl: release.html_url,
    targets: engineTargets.map((target) => {
      const files = index.targets.find((entry) => entry.target === target);
      if (files == undefined) {
        throw new UnreachableError();
      }
      const link = (name: string): { name: string; url: string } => {
        const asset = assetsByName.get(name);
        if (asset == undefined) {
          throw new UnreachableError();
        }
        return { name, url: asset.browser_download_url };
      };
      return {
        target,
        sevenZip: {
          list: link(files.sevenZip.list),
          parts: files.sevenZip.parts.map(link),
        },
        vvpp: {
          list: link(files.vvpp.list),
          parts: files.vvpp.parts.map(link),
        },
      };
    }),
  };
}
