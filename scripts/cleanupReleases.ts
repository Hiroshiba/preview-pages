import fs from "node:fs/promises";
import { RequestError } from "octokit";
import {
  cacheRepo,
  destinationDir,
  octokit,
  rootLogger,
  splitRepoName,
} from "./common.ts";
import { ReleaseData } from "./constants.ts";
import { getReleaseTag, getReleaseTagPrefix, listReleases } from "./release.ts";

async function main() {
  const releasesData = JSON.parse(
    await fs.readFile(`${destinationDir}/releases.json`, "utf8"),
  ) as ReleaseData[];

  const releases = await listReleases();
  for (const data of releasesData) {
    const prefix = getReleaseTagPrefix(data.key);
    const retainedTag = getReleaseTag(data.key, data.runId);
    for (const release of releases) {
      if (
        !release.tag_name.startsWith(prefix) ||
        release.tag_name === retainedTag
      ) {
        continue;
      }
      try {
        await octokit.rest.git.deleteRef({
          ...splitRepoName(cacheRepo),
          ref: `tags/${release.tag_name}`,
          request: { retries: 0 },
        });
      } catch (error) {
        if (!(error instanceof RequestError && error.status === 404)) {
          throw error;
        }
      }
      await octokit.rest.repos.deleteRelease({
        ...splitRepoName(cacheRepo),
        release_id: release.id,
        request: { retries: 0 },
      });
      rootLogger.info`Deleted old release: ${release.tag_name}`;
    }
  }
}

await main();
