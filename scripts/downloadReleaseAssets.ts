import fs from "node:fs/promises";
import fsSync from "node:fs";
import { pipeline } from "node:stream/promises";
import { Logger } from "@logtape/logtape";
import { destinationDir } from "./common.ts";
import { ReleaseData } from "./constants.ts";
import {
  processAllReleases,
  ReleaseSelection,
  transferReleaseFiles,
} from "./release.ts";

async function main() {
  await processAllReleases(downloadRelease);
}

async function downloadRelease(
  log: Logger,
  releaseSelection: ReleaseSelection,
): Promise<ReleaseData> {
  const { source } = releaseSelection;
  const pathFragment = `${source.repoKey}/release-branch-${source.branch}`;
  const outputDirPath = `${destinationDir}/${pathFragment}`;
  await fs.mkdir(outputDirPath, { recursive: true });
  const files = await transferReleaseFiles(
    log,
    releaseSelection,
    async (name, content) => {
      const filePath = `${outputDirPath}/${name}`;
      await pipeline(content, fsSync.createWriteStream(filePath));
      const { size } = await fs.stat(filePath);
      return { name, size, url: `preview/${pathFragment}/${name}` };
    },
  );
  log.info`Downloaded release files to ${outputDirPath}`;
  return { ...source, files };
}

await main();
