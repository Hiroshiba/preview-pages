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
      v-if="detailBranch != null"
      :repoKey="currentRepo"
      :branch="detailBranch"
    />
    <DownloadList v-else v-model:currentRepo="currentRepo" />
  </main>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { TargetRepoKey } from "../scripts/common.ts";
import { targetRepos } from "../scripts/constants.ts";
import DownloadList from "./components/DownloadList.vue";
import ReleaseDetail from "./components/ReleaseDetail.vue";
import { useColorScheme } from "./composables/useColorScheme.ts";

useColorScheme();

const currentRepo = ref<TargetRepoKey>("editor");
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

const detailBranch = new URLSearchParams(location.search).get("release");
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
</style>
