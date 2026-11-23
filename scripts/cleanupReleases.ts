// TODO: cleanupCaches.tsとほぼ同じ処理なので、共通化する。

import { RequestError } from "octokit";
import {
  distributionReleaseName,
  distributionRepo,
  octokit,
  splitRepoName,
  rootLogger,
  isTargetBranch,
  UnreachableError,
} from "./common.ts";
import { targetRepos, TargetRepoKey, Release } from "./constants.ts";

const log = rootLogger.getChild("cleanup");

type ParsedAsset = {
  repoKey: TargetRepoKey;
  sourceKey: string;
  runId: number;
  assetId: number;
  assetName: string;
};

const repoKeyPattern = Object.keys(targetRepos).join("|");
const assetPattern = new RegExp(
  `^(${repoKeyPattern})-(.+?)-(\\d+)(?:--.+|\\.json)$`,
);

function parseAssetName(
  name: string,
  assetId: number,
): ParsedAsset | undefined {
  const match = name.match(assetPattern);
  if (!match) return undefined;
  return {
    repoKey: match[1] as TargetRepoKey,
    sourceKey: match[2],
    runId: parseInt(match[3], 10),
    assetId,
    assetName: name,
  };
}

async function main() {
  log.info`Fetching release assets from ${distributionReleaseName}...`;

  let release: Release;
  try {
    const response = await octokit.rest.repos.getReleaseByTag({
      ...splitRepoName(distributionRepo),
      tag: distributionReleaseName,
    });
    release = response.data;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      log.info`Release ${distributionReleaseName} not found. Nothing to clean.`;
      return;
    }
    throw error;
  }

  const assets = release.assets;
  log.info`Found ${assets.length} assets.`;

  const parsed: ParsedAsset[] = [];
  for (const asset of assets) {
    const p = parseAssetName(asset.name, asset.id);
    if (p) {
      parsed.push(p);
    } else {
      log.warn`Skipping unrecognized asset: ${asset.name}`;
    }
  }

  const grouped = new Map<string, ParsedAsset[]>();
  for (const p of parsed) {
    const key = `${p.repoKey}-${p.sourceKey}`;
    if (!grouped.has(key)) grouped.set(key, []);
    const groupedAssets = grouped.get(key);
    if (!groupedAssets) {
      throw new UnreachableError();
    }
    groupedAssets.push(p);
  }

  const toDelete: ParsedAsset[] = [];
  const existingBranchesByRepo = new Map<TargetRepoKey, Set<string>>();

  for (const [, assetList] of grouped) {
    const { repoKey, sourceKey } = assetList[0];

    if (sourceKey.startsWith("pr-")) {
      const prNumber = parseInt(sourceKey.slice(3), 10);
      let isClosed: boolean;
      try {
        const { data: pr } = await octokit.rest.pulls.get({
          ...splitRepoName(repoKey),
          pull_number: prNumber,
        });
        isClosed = pr.state === "closed";
      } catch {
        log.warn`Failed to fetch PR #${prNumber} for ${repoKey}, skipping.`;
        continue;
      }

      if (isClosed) {
        log.info`PR #${prNumber} (${repoKey}) is closed. Marking all ${assetList.length} asset(s) for deletion.`;
        toDelete.push(...assetList);
      } else {
        const oldAssets = filterOldAssets(assetList);
        if (oldAssets.length > 0) {
          log.info`PR #${prNumber} (${repoKey}) has ${oldAssets.length} old asset(s). Marking for deletion.`;
          toDelete.push(...oldAssets);
        }
      }
    } else {
      const branchName = sourceKey.replace(/^branch-/, "");
      const existingBranches = await getExistingTargetBranches(
        repoKey,
        existingBranchesByRepo,
      );
      if (!existingBranches.has(branchName)) {
        log.info`Branch ${branchName} (${repoKey}) no longer exists. Marking all ${assetList.length} asset(s) for deletion.`;
        toDelete.push(...assetList);
        continue;
      }

      const oldAssets = filterOldAssets(assetList);
      if (oldAssets.length > 0) {
        log.info`Branch ${sourceKey} (${repoKey}) has ${oldAssets.length} old asset(s). Marking for deletion.`;
        toDelete.push(...oldAssets);
      }
    }
  }

  if (toDelete.length === 0) {
    log.info`No assets to delete.`;
    return;
  }

  log.info`Deleting ${toDelete.length} asset(s)...`;
  for (const asset of toDelete) {
    log.info`Deleting ${asset.assetName}...`;
    await octokit.rest.repos.deleteReleaseAsset({
      ...splitRepoName(distributionRepo),
      asset_id: asset.assetId,
    });
  }
  log.info`Done. Deleted ${toDelete.length} asset(s).`;
}

function filterOldAssets(assetList: ParsedAsset[]): ParsedAsset[] {
  const latestRunId = Math.max(...assetList.map((asset) => asset.runId));
  return assetList.filter((asset) => asset.runId !== latestRunId);
}

async function getExistingTargetBranches(
  repoKey: TargetRepoKey,
  existingBranchesByRepo: Map<TargetRepoKey, Set<string>>,
): Promise<Set<string>> {
  const cached = existingBranchesByRepo.get(repoKey);
  if (cached != undefined) {
    return cached;
  }

  const branches = await octokit.paginate(
    "GET /repos/{owner}/{repo}/branches",
    splitRepoName(repoKey),
  );
  const existingBranches = new Set(
    branches
      .filter((branch) => isTargetBranch(branch.name))
      .map((branch) => branch.name),
  );
  existingBranchesByRepo.set(repoKey, existingBranches);
  return existingBranches;
}

await main();
