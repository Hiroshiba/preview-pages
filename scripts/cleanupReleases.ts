import fs from "node:fs/promises";
import {
  destinationDir,
  distributionReleaseName,
  rootLogger,
} from "./common.ts";
import { ReleaseData } from "./constants.ts";
import {
  createReleaseBranchPrefix,
  createReleaseRunPrefix,
  deleteReleaseAsset,
  getDistributionRelease,
} from "./release.ts";

const log = rootLogger.getChild("cleanup");

async function main() {
  const releases = JSON.parse(
    await fs.readFile(`${destinationDir}/releases.json`, "utf-8"),
  ) as ReleaseData[];

  const distributionRelease = await getDistributionRelease();
  if (distributionRelease == undefined) {
    log.info`Release ${distributionReleaseName} not found. Nothing to clean.`;
    return;
  }
  for (const release of releases) {
    const prefix = createReleaseBranchPrefix(release.repoKey, release.branch);
    const retainedPrefix = createReleaseRunPrefix(release);
    for (const asset of distributionRelease.assets) {
      if (
        !asset.name.startsWith(prefix) ||
        asset.name.startsWith(retainedPrefix)
      ) {
        continue;
      }
      log.info`Deleting ${asset.name}...`;
      await deleteReleaseAsset(asset);
    }
  }
}

await main();
