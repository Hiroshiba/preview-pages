<template>
  <header class="header">
    <a
      href="https://github.com/VOICEVOX/preview-pages"
      target="_blank"
      rel="noopener noreferrer"
      class="header-link"
    >
      VOICEVOX Preview Pages
    </a>
  </header>
  <main class="main">
    <ReleaseDetail
      v-if="releaseSourceKey != undefined"
      :repoKey="currentRepo"
      :sourceKey="releaseSourceKey"
    />
    <template v-else>
      <p>プレビューするBranchまたはPull Requestを選択してください。</p>
      <section class="selector">
        <ElButtonGroup>
          <ElButton
            v-for="(targetRepo, repoKey) in targetRepos"
            :key="repoKey"
            :type="currentRepo === repoKey ? 'primary' : 'default'"
            @click="switchRepo(repoKey)"
          >
            {{ targetRepo.label }}（<a
              :href="`https://github.com/${targetRepo.repo}`"
              target="_blank"
              rel="noopener noreferrer"
              class="download-source-link"
              >{{ targetRepo.repo }}</a
            >
            ）
          </ElButton>
        </ElButtonGroup>
      </section>
      <section class="downloads">
        <template v-if="previewData.loading">
          <ElLoading />
        </template>
        <template v-else>
          <ElCard v-for="card in cards" :key="card.key" class="download-card">
            <template #header>
              <SourceLabel
                :source="card.source"
                :repo="targetRepos[currentRepo].repo"
              />
            </template>

            <template v-if="card.download != undefined">
              <ElButton
                v-for="link in getLinks(currentRepo)"
                :key="link.label"
                :type="link.buttonType"
                :href="joinUrl(`${card.download.pathFragment}/${link.path}`)"
                tag="a"
                target="_blank"
                >{{ link.label }}</ElButton
              >
            </template>
            <ElButton
              v-if="card.release != undefined"
              type="primary"
              :href="releaseUrl(card.key)"
              tag="a"
              >リリース</ElButton
            >
          </ElCard>
        </template>
      </section>
    </template>
  </main>
</template>

<script setup lang="ts">
import { ElButton, ElButtonGroup, ElCard, ElLoading } from "element-plus";
import { computed, ref, onMounted, watch } from "vue";
import { TargetRepoKey } from "../scripts/common.ts";
import {
  DownloadData,
  ReleaseData,
  Source,
  createSourceKey,
  targetRepos,
} from "../scripts/constants.ts";
import ReleaseDetail from "./components/ReleaseDetail.vue";
import SourceLabel from "./components/SourceLabel.vue";
import { usePreviewData } from "./composables/usePreviewData.ts";
import { useColorScheme } from "./composables/useColorScheme.ts";
import { UnreachableError } from "./utils.ts";

const previewData = usePreviewData();
useColorScheme();

const currentRepo = ref<TargetRepoKey>("editor");
const switchRepo = (repo: TargetRepoKey) => {
  currentRepo.value = repo;
};
onMounted(() => {
  const search = new URLSearchParams(location.search);
  const repo = search.get("repo") as TargetRepoKey | null;
  if (repo && repo in targetRepos) {
    currentRepo.value = repo;
  }
});
watch(currentRepo, (newVal) => {
  const search = new URLSearchParams(location.search);
  search.set("repo", newVal);
  history.replaceState(null, "", `${location.pathname}?${search.toString()}`);
});

type Card = {
  key: string;
  source: Source;
  download: DownloadData | undefined;
  release: ReleaseData | undefined;
};

const cards = computed(() => {
  if (previewData.value.loading) {
    return [];
  }
  const { downloads: downloadResults, releases } = previewData.value.result;
  const cardMap = new Map<string, Card>();
  for (const download of downloadResults[currentRepo.value]?.data ?? []) {
    const key = createSourceKey(download.source);
    cardMap.set(key, {
      key,
      source: download.source,
      download,
      release: undefined,
    });
  }
  for (const release of releases[currentRepo.value]?.data ?? []) {
    const key = createSourceKey(release.source);
    const card = cardMap.get(key);
    if (card == undefined) {
      cardMap.set(key, {
        key,
        source: release.source,
        download: undefined,
        release,
      });
    } else {
      card.release = release;
    }
  }
  return [...cardMap.values()];
});

const getLinks = (repoKey: TargetRepoKey) => {
  const targetRepo = targetRepos[repoKey];
  if (!("links" in targetRepo)) {
    throw new UnreachableError();
  }
  return targetRepo.links;
};

const releaseSourceKey = new URLSearchParams(location.search).get("release");
const releaseUrl = (sourceKey: string) =>
  `${location.pathname}?${new URLSearchParams({ repo: currentRepo.value, release: sourceKey }).toString()}`;

const joinUrl = (path: string) =>
  `${import.meta.env.BASE_URL}/preview/${path}`.replace(/\/+/g, "/");
</script>

<style scoped lang="scss">
@use "@/styles/index.scss" as main;

.header {
  align-content: center;
  padding: 1rem;

  html.light & {
    color: #000000;
    background: main.$theme-light;
  }
  html.dark & {
    color: main.$theme-dark;
    background: #2b2b2b;
  }

  font-size: 1.5rem;
  font-weight: bold;
}

.header-link {
  color: currentColor;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.main {
  padding: 1rem;
  margin-left: auto;
  margin-right: auto;
}

.download-source-link {
  color: currentColor;
}

.selector {
  margin-bottom: 1rem;
  display: flex;
}

.downloads {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(600px, 1fr));
}

.download-card :deep(.el-card__body) {
  display: flex;
  gap: 1rem;
}
</style>
