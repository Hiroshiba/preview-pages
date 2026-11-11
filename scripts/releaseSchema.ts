import { z } from "zod";
import { releaseTargets } from "./constants.ts";

export const releaseFileNameSchema = z
  .string()
  .regex(/^[^/\\]+$/)
  .refine((name) => name !== "." && name !== "..");

const releaseFileSchema = z.strictObject({
  name: releaseFileNameSchema,
  size: z.number().int().nonnegative(),
  url: z.url(),
});

const releaseDataSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({
    status: z.literal("available"),
    branch: z.string().min(1),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    runId: z.number().int().positive(),
    files: z
      .array(releaseFileSchema)
      .min(1)
      .refine(
        (files) =>
          new Set(files.map((file) => file.name)).size === files.length,
        "配布ファイル名が重複しています",
      ),
  }),
]);

export const releaseResultsSchema = z
  .record(z.string(), releaseDataSchema)
  .refine(
    (results) =>
      Object.keys(results).length === Object.keys(releaseTargets).length &&
      Object.entries(releaseTargets).every(([key, target]) => {
        const result = results[key];
        return (
          result != undefined &&
          (result.status === "unavailable" || result.branch === target.branch)
        );
      }),
    "配布対象とリリース一覧が一致しません",
  );

export type ReleaseData = z.infer<typeof releaseDataSchema>;
export type AvailableRelease = Extract<ReleaseData, { status: "available" }>;
export type ReleaseResults = z.infer<typeof releaseResultsSchema>;
