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
export type ReleaseFile = {
  name: string;
  size: number;
  artifactId: number;
  url: string;
};
export type ReleaseData = {
  source: Source;
  runId: number;
  cached: boolean;
  files: ReleaseFile[];
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
  engine: {
    repo: "VOICEVOX/voicevox_engine",
    label: "エンジン",
    release: true,
  },
} as const satisfies Record<
  string,
  {
    repo: string;
    label: string;

    links?: {
      path: string;
      buttonType: "success" | "danger";
      emoji: string;
      label: string;
    }[];
    release?: true;
  }
>;

export type TargetRepoKey = keyof typeof targetRepos;

export type DownloadResult = {
  repoKey: TargetRepoKey;
  data: DownloadData[];
  numTargets: number;
};

export type ReleaseResult = {
  repoKey: TargetRepoKey;
  data: ReleaseData[];
  numTargets: number;
};

export type PreviewData = {
  downloads: Partial<Record<TargetRepoKey, DownloadResult>>;
  releases: Partial<Record<TargetRepoKey, ReleaseResult>>;
};

export class ExhaustiveError extends Error {
  constructor(value: never) {
    super(`Not exhaustive. value: ${String(value)}`);
  }
}

export function createSourceKey(source: Source): string {
  switch (source.type) {
    case "pullRequest":
      return `pr-${source.pullRequest.number}`;
    case "branch":
      return `branch-${source.branch.name}`;
    default:
      throw new ExhaustiveError(source);
  }
}
