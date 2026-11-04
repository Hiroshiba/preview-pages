import fs from "node:fs/promises";
import { RequestError } from "octokit";
import {
  cacheRepo,
  destinationDir,
  octokit,
  rootLogger,
  splitRepoName,
} from "./common.ts";
import { engineDownloadSchema } from "./engineDownloadSchema.ts";

async function main(): Promise<void> {
  const downloads = engineDownloadSchema.parse(
    JSON.parse(
      await fs.readFile(`${destinationDir}/engine-downloads.json`, "utf8"),
    ),
  );
  if (downloads.status === "unavailable") {
    rootLogger.info("ENGINEの公開一覧がないためReleaseを整理しません。");
    return;
  }
  const retainedTag = `engine-master-run-${downloads.runId}`;
  const releases = await octokit.paginate(
    "GET /repos/{owner}/{repo}/releases",
    { ...splitRepoName(cacheRepo), per_page: 100 },
  );
  for (const release of releases) {
    if (
      !/^engine-master-run-\d+$/.test(release.tag_name) ||
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
    rootLogger.info`ENGINEの旧Releaseを削除しました: ${release.tag_name}`;
  }
}

await main();
