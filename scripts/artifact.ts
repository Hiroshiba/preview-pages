import { Readable } from "node:stream";
import { Logger } from "@logtape/logtape";
import { octokit, splitRepoName, TargetRepoKey } from "./common.ts";

export type ReleaseArtifact = { id: number; name: string };

export async function fetchArtifactDownloadUrl(
  log: Logger,
  repoKey: TargetRepoKey,
  artifact: ReleaseArtifact,
): Promise<string> {
  log.info`Fetching artifact URL: ${artifact.name}`;
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
    {
      ...splitRepoName(repoKey),
      artifact_id: artifact.id,
      archive_format: "zip",
      request: { redirect: "manual" },
    },
  );
  if (response.headers.location == undefined) {
    throw new Error(`Artifact "${artifact.name}" does not have a download URL`);
  }
  return response.headers.location;
}

export async function fetchArtifactBody(url: string): Promise<Readable> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download artifact: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new Error("Response body is empty");
  }
  return Readable.fromWeb(response.body);
}
