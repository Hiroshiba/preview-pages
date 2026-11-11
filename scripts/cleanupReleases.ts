import fs from "node:fs/promises";
import { RequestError } from "octokit";
import {
  cacheRepo,
  destinationDir,
  octokit,
  rootLogger,
  splitRepoName,
} from "./common.ts";
import {
  isReleaseTargetKey,
  releaseTargets,
  ReleaseTargetKey,
} from "./constants.ts";
import { getReleaseTag } from "./release.ts";
import { releaseResultsSchema } from "./releaseSchema.ts";

async function main() {
  const releasesData = releaseResultsSchema.parse(
    JSON.parse(await fs.readFile(`${destinationDir}/releases.json`, "utf8")),
  );
  const retained = new Map<ReleaseTargetKey, string>();
  for (const [key] of Object.entries(releaseTargets)) {
    if (!isReleaseTargetKey(key)) {
      throw new Error(`不明な配布対象です: ${key}`);
    }
    const releaseKey = key;
    const data = releasesData[releaseKey];
    if (data.status === "available") {
      retained.set(releaseKey, getReleaseTag(releaseKey, data.runId));
    }
  }
  if (retained.size === 0) {
    rootLogger.info("公開済みの配布一覧がないためReleaseを整理しません。");
    return;
  }

  const releases = await octokit.paginate(
    "GET /repos/{owner}/{repo}/releases",
    { ...splitRepoName(cacheRepo), per_page: 100 },
  );
  for (const release of releases) {
    for (const [key, retainedTag] of retained) {
      const prefix = `preview-pages-download-${key}-run-`;
      const suffix = release.tag_name.slice(prefix.length);
      if (
        !release.tag_name.startsWith(prefix) ||
        !/^\d+$/.test(suffix) ||
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
      rootLogger.info`旧Releaseを削除しました: ${release.tag_name}`;
    }
  }
}

await main();
