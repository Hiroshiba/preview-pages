import { ref } from "vue";
import {
  EngineDownloads,
  engineDownloadSchema,
} from "../../scripts/engineDownloadSchema.ts";

const engineDownloadResultRef = ref<
  { loading: false; result: EngineDownloads } | { loading: true }
>({ loading: true });

void fetch(
  `${import.meta.env.BASE_URL}/preview/engine-downloads.json`.replace(
    /\/\//g,
    "/",
  ),
).then(async (response) => {
  if (!response.ok) {
    throw new Error(`ENGINEの一覧を取得できません: ${response.statusText}`);
  }
  const data = engineDownloadSchema.parse(await response.json());
  engineDownloadResultRef.value = { loading: false, result: data };
});

/** ENGINE開発版の配布一覧を返す。 */
export function useEngineDownloadData(): typeof engineDownloadResultRef {
  return engineDownloadResultRef;
}
