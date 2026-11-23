<template>
  <div class="release-detail">
    <nav class="release-nav">
      <a :href="listUrl">{{ targetRepos[repoKey].label }}の一覧</a>
      ／ リリース
    </nav>
    <h2 class="release-title">{{ targetRepos[repoKey].label }}のリリース</h2>
    <a :href="`https://github.com/${targetRepos[repoKey].repo}`">
      {{ targetRepos[repoKey].repo }}
    </a>
    <ElLoading v-if="previewData.loading" />
    <p v-else-if="release == undefined">リリースが見つかりませんでした。</p>
    <template v-else>
      <div class="release-source">
        <SourceLabel
          :source="release.source"
          :repo="targetRepos[repoKey].repo"
        />
      </div>
      <h3>配布ファイル</h3>
      <ul class="release-files">
        <li v-for="file in release.files" :key="file.name" class="release-file">
          <a :href="file.url">{{ file.name }}</a>
          <span>{{ formatFileSize(file.size) }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ElLoading } from "element-plus";
import { computed } from "vue";
import { TargetRepoKey } from "../../scripts/common.ts";
import { createSourceKey, targetRepos } from "../../scripts/constants.ts";
import { usePreviewData } from "../composables/usePreviewData.ts";
import SourceLabel from "./SourceLabel.vue";

const props = defineProps<{
  repoKey: TargetRepoKey;
  sourceKey: string;
}>();
const previewData = usePreviewData();

const release = computed(() => {
  if (previewData.value.loading) {
    return undefined;
  }
  return previewData.value.result.releases[props.repoKey]?.data.find(
    (data) => createSourceKey(data.source) === props.sourceKey,
  );
});

function formatFileSize(size: number): string {
  if (size >= 1024 ** 3) {
    return `${(size / 1024 ** 3).toFixed(1)} GiB`;
  }
  if (size >= 1024 ** 2) {
    return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KiB`;
  }
  return `${size} B`;
}

const listUrl = computed(
  () =>
    `${location.pathname}?${new URLSearchParams({ repo: props.repoKey }).toString()}`,
);
</script>

<style scoped lang="scss">
.release-detail {
  max-width: 900px;
}

.release-nav {
  margin: 1rem 0 1.5rem;
}

.release-title {
  margin-bottom: 0.25rem;
}

.release-source {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1.5rem 0;
  padding: 1rem 0;
  border-top: 1px solid var(--el-border-color);
  border-bottom: 1px solid var(--el-border-color);
}

.release-files {
  list-style: none;
  padding: 0;
}

.release-file {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--el-border-color);
  overflow-wrap: anywhere;
}
</style>
