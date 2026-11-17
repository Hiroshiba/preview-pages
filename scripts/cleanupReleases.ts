import fs from "node:fs/promises";
import { destinationDir, rootLogger } from "./common.ts";
import { ReleaseData } from "./constants.ts";
import {
  deleteRelease,
  getReleaseTag,
  getReleaseTagPrefix,
  listReleases,
} from "./release.ts";

async function main() {
  const releasesData = JSON.parse(
    await fs.readFile(`${destinationDir}/releases.json`, "utf8"),
  ) as ReleaseData[];

  const releases = await listReleases();
  for (const data of releasesData) {
    const prefix = getReleaseTagPrefix(data.repoKey);
    const retainedTag = getReleaseTag(data.repoKey, data.runId);
    for (const release of releases) {
      if (
        !release.tag_name.startsWith(prefix) ||
        release.tag_name === retainedTag
      ) {
        continue;
      }
      await deleteRelease(release);
      rootLogger.info`Deleted old release: ${release.tag_name}`;
    }
  }
}

await main();
