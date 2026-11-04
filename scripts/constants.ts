// NOTE: このファイルはフロントエンドからもimportされるため、common.tsのimportは避ける
import { Endpoints } from "@octokit/types";
import { z } from "zod";

export const engineRepo = "VOICEVOX/voicevox_engine";
export const engineBranch = "master";
export const engineTargets = z.enum([
  "windows-cpu",
  "windows-directml",
  "windows-nvidia",
  "macos-x64",
  "macos-arm64",
  "linux-cpu-x64",
  "linux-cpu-arm64",
  "linux-nvidia",
]).options;

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

export type TargetRepoKey = keyof typeof targetRepos;

export type DownloadResult = {
  repoKey: TargetRepoKey;
  data: DownloadData[];
  numTargets: number;
};
