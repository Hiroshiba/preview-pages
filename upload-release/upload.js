import fs from "node:fs";
import path from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";

/** 配布ファイルを1つずつzipにせず、preview-pages用のArtifactとしてアップロードする。 */
export default async function uploadReleaseFiles({ core, glob, uploadPath }) {
  const globber = await glob.create(uploadPath, { matchDirectories: false });
  const files = await globber.glob();
  if (files.length === 0) {
    throw new Error(`No files found: ${uploadPath}`);
  }

  // zipにしない場合、Artifact名はファイル名になるため、接頭辞付きの名前のリンクを作ってアップロードする。
  const linkDir = fs.mkdtempSync(
    path.join(process.env.RUNNER_TEMP, "upload-release-"),
  );
  const client = new DefaultArtifactClient();
  for (const file of files) {
    const artifactName = `preview-pages-release-${path.basename(file)}`;
    const link = path.join(linkDir, artifactName);
    fs.symlinkSync(file, link);
    await client.uploadArtifact(artifactName, [link], linkDir, {
      skipArchive: true,
    });
    core.info(`Uploaded ${file} as ${artifactName}`);
  }
}
