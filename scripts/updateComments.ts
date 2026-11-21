import fs from "node:fs/promises";
import {
  getAppInfo,
  commentMarker,
  commentMarkers,
  octokit,
  pagesUrl,
  rootLogger,
  destinationDir,
  DownloadResult,
  splitRepoName,
  UnreachableError,
} from "./common.ts";
import {
  PullRequest,
  Source,
  TargetRepoKey,
  targetRepos,
} from "./constants.ts";

async function main() {
  const downloadResults = JSON.parse(
    await fs.readFile(`${destinationDir}/downloads.json`, "utf-8"),
  ) as Record<TargetRepoKey, DownloadResult>;

  let allPullRequests = 0;
  let newComments = 0;
  let updatedComments = 0;

  for (const { repoKey, data } of Object.values(downloadResults)) {
    for (const source of data) {
      const result = await updateComments(
        repoKey,
        source.pathFragment,
        source.source,
      );
      switch (result) {
        case "notAPullRequest":
          continue;
        case "new":
          allPullRequests += 1;
          newComments += 1;
          break;
        case "updated":
          allPullRequests += 1;
          updatedComments += 1;
          break;
        case "skipped":
          allPullRequests += 1;
          continue;
      }
    }
  }

  rootLogger.info`Done: ${newComments} new comments, ${updatedComments} updated comments / ${allPullRequests} PRs`;
}

async function updateComments(
  repoKey: TargetRepoKey,
  path: string,
  source: Source,
): Promise<"notAPullRequest" | "new" | "updated" | "skipped"> {
  if (source.type === "branch") {
    return "notAPullRequest";
  }

  const appInfo = getAppInfo();

  const log = rootLogger.getChild(`PR #${source.pullRequest.number}`);

  const deployInfoMessage = createDeployInfoMessage(repoKey, path, source);

  log.info("Fetching comments...");
  const comments = await octokit.paginate(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      ...splitRepoName(repoKey),
      issue_number: source.pullRequest.number,
    },
  );
  const maybePreviousDeployInfo = comments.find(
    (comment) =>
      comment.user &&
      appInfo.data &&
      comment.user.login === `${appInfo.data.slug}[bot]` &&
      commentMarkers.some((marker) => comment.body?.endsWith(marker)),
  );

  if (!maybePreviousDeployInfo) {
    log.info("Adding deploy info...");
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        ...splitRepoName(repoKey),
        issue_number: source.pullRequest.number,
        body: deployInfoMessage,
      },
    );
    return "new";
  } else if (maybePreviousDeployInfo.body === deployInfoMessage) {
    log.info("No update in deploy info, skipped.");
    return "skipped";
  } else {
    log.info("Updating deploy info...");
    await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {
        ...splitRepoName(repoKey),
        comment_id: maybePreviousDeployInfo.id,
        body: deployInfoMessage,
      },
    );

    return "updated";
  }
}

function createDeployInfoMessage(
  repoKey: TargetRepoKey,
  path: string,
  source: { type: "pullRequest"; pullRequest: PullRequest },
) {
  const targetRepo = targetRepos[repoKey];
  if (targetRepo.links == undefined) {
    throw new UnreachableError();
  }
  return [
    ":rocket: プレビュー用ページを作成しました :rocket:",
    "",
    ...targetRepo.links.map(
      ({ path: linkPath, emoji, label }) =>
        `- <a href="${pagesUrl}/preview/${path}/${linkPath}" target="_blank">${emoji} ${label}</a>`,
    ),
    "",
    `更新時点でのコミットハッシュ：[\`${source.pullRequest.head.sha.slice(0, 7)}\`](https://github.com/${source.pullRequest.head.repo.full_name}/commit/${source.pullRequest.head.sha})`,
    commentMarker,
  ].join("\n");
}

await main();
