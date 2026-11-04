import { z } from "zod";
import { engineTargets } from "./constants.ts";

const targetSchema = z.enum(engineTargets);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const fileNameSchema = z
  .string()
  .regex(/^[^/\\]+$/)
  .min(1);
const targetSetSchema = <T extends z.ZodType<{ target: string }>>(item: T) =>
  z
    .array(item)
    .length(engineTargets.length)
    .refine(
      (targets) =>
        new Set(targets.map(({ target }) => target)).size ===
        engineTargets.length,
      "ENGINEの構成が重複しています",
    );

export const engineManifestSchema = z
  .strictObject({
    runId: z.number().int().positive(),
    commitSha: shaSchema,
    version: z.string().min(1),
    targets: targetSetSchema(
      z.strictObject({
        target: targetSchema,
        sevenZipArtifact: fileNameSchema,
        vvppArtifact: fileNameSchema,
      }),
    ),
  })
  .refine(
    ({ version, targets }) =>
      targets.every(({ target, sevenZipArtifact, vvppArtifact }) => {
        const packageName = `voicevox_engine-${target}-${version}`;
        return (
          sevenZipArtifact === `${packageName}-7z` &&
          vvppArtifact === `${packageName}-vvpp`
        );
      }),
    "ENGINEのArtifact名が構成と版に一致しません",
  );

const indexFormatSchema = z.strictObject({
  list: fileNameSchema,
  parts: z.array(fileNameSchema).min(1),
});

export const engineIndexSchema = z.strictObject({
  runId: z.number().int().positive(),
  commitSha: shaSchema,
  version: z.string().min(1),
  targets: targetSetSchema(
    z.strictObject({
      target: targetSchema,
      sevenZip: indexFormatSchema,
      vvpp: indexFormatSchema,
    }),
  ),
});

const downloadFileSchema = z.strictObject({
  name: fileNameSchema,
  url: z.url(),
});

const downloadFormatSchema = z.strictObject({
  list: downloadFileSchema,
  parts: z.array(downloadFileSchema).min(1),
});

export const engineDownloadSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({
    status: z.literal("available"),
    runId: z.number().int().positive(),
    commitSha: shaSchema,
    version: z.string().min(1),
    releaseUrl: z.url(),
    targets: targetSetSchema(
      z.strictObject({
        target: targetSchema,
        sevenZip: downloadFormatSchema,
        vvpp: downloadFormatSchema,
      }),
    ),
  }),
]);

export type EngineManifest = z.infer<typeof engineManifestSchema>;
export type EngineIndex = z.infer<typeof engineIndexSchema>;
export type EngineDownloads = z.infer<typeof engineDownloadSchema>;
