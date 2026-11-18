import fs from "node:fs/promises";
import {
  destinationDir,
  distributionReleaseName,
  rootLogger,
} from "./common.ts";
import { ReleaseData } from "./constants.ts";
import {
  createReleaseFilePrefix,
  createReleaseRunPrefix,
  deleteReleaseAsset,
  getRelease,
} from "./release.ts";

const log = rootLogger.getChild("cleanup");

async function main() {
  const releasesData = JSON.parse(
    await fs.readFile(`${destinationDir}/releases.json`, "utf8"),
  ) as ReleaseData[];

  const release = await getRelease();
  if (release == undefined) {
    log.info`Release ${distributionReleaseName} not found. Nothing to clean.`;
    return;
  }
  for (const data of releasesData) {
    const prefix = createReleaseFilePrefix(data.repoKey, data.branch);
    const retainedPrefix = createReleaseRunPrefix(data);
    for (const asset of release.assets) {
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
