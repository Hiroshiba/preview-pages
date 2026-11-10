// NOTE: このファイルはフロントエンドからもimportされるため、common.tsのimportは避ける
import { Endpoints } from "@octokit/types";

export type Branch =
  Endpoints["GET /repos/{owner}/{repo}/branches"]["response"]["data"][0];
export type PullRequest =
  Endpoints["GET /repos/{owner}/{repo}/pulls"]["response"]["data"][0];
export type Release =
  Endpoints["GET /repos/{owner}/{repo}/releases"]["response"]["data"][0];
export type Source =
  | {
      type: "branch";
      branch: Branch;
    }
  | {
      type: "pullRequest";
      pullRequest: PullRequest;
    };
export type DownloadData = {
  source: Source;
  pathFragment: string;
  runId: number;
  cached: boolean;
};

export const targetRepos = {
  editor: {
    repo: "VOICEVOX/voicevox",
    label: "エディタ",
    links: [
      {
        path: "editor/index.html",
        buttonType: "success",
        emoji: ":pencil:",
        label: "エディタ",
      },
      {
        path: "storybook/index.html",
        buttonType: "danger",
        emoji: ":book:",
        label: "Storybook",
      },
    ],
  },
  blog: {
    repo: "VOICEVOX/voicevox_blog",
    label: "ホームページ",
    links: [
      {
        path: "index.html",
        buttonType: "success",
        emoji: ":house:",
        label: "ホームページ",
      },
    ],
  },
  docs: {
    repo: "VOICEVOX/WIP_docs",
    label: "ドキュメント",
    links: [
      {
        path: "index.html",
        buttonType: "success",
        emoji: ":green_book:",
        label: "ドキュメント",
      },
    ],
  },
} as const satisfies Record<
  string,
  {
    repo: string;
    label: string;

    links: {
      path: string;
      buttonType: "success" | "danger";
      emoji: string;
      label: string;
    }[];
  }
>;

export const releaseTargets = {
  engine: {
    repo: "VOICEVOX/voicevox_engine",
    label: "エンジン",
    branch: "master",
  },
} as const satisfies Record<
  string,
  { repo: `${string}/${string}`; label: string; branch: string }
>;

export type ReleaseTargetKey = keyof typeof releaseTargets;

/** 配布対象のkeyかどうかを判定する。 */
export function isReleaseTargetKey(key: string): key is ReleaseTargetKey {
  return key in releaseTargets;
}

/** Web対象のkeyかどうかを判定する。 */
export function isTargetRepoKey(key: string): key is TargetRepoKey {
  return key in targetRepos;
}

export type TargetRepoKey = keyof typeof targetRepos;

export type DownloadResult = {
  repoKey: TargetRepoKey;
  data: DownloadData[];
  numTargets: number;
};
