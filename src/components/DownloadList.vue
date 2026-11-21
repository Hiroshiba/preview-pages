<template>
  <p>BranchまたはPull Requestを選択してください。</p>
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
    <template v-else-if="currentTargetRepo.links != undefined">
      <ElCard
        v-for="download in previewData.downloads[currentRepo].data"
        :key="download.pathFragment"
        class="download-card"
      >
        <template #header>
          <template v-if="download.source.type === 'branch'">
            <ElTag type="primary" disableTransitions>Branch</ElTag>
            <a
              class="download-source"
              :href="`https://github.com/${targetRepos[currentRepo].repo}/tree/${download.source.branch.name}`"
              @click.stop
            >
              {{ download.source.branch.name }}
            </a>
            ：
            <a
              :href="`https://github.com/${targetRepos[currentRepo].repo}/commit/${download.source.branch.commit.sha}`"
              @click.stop
            >
              {{ download.source.branch.commit.sha.slice(0, 7) }}
            </a>
          </template>
          <template v-if="download.source.type === 'pullRequest'">
            <ElTag type="success" disableTransitions>Pull Request</ElTag>
            <a
              class="download-source"
              :href="download.source.pullRequest.html_url"
              @click.stop
            >
              #{{ download.source.pullRequest.number }} （{{
                download.source.pullRequest.title
              }}）
            </a>
            ：
            <a
              :href="`https://github.com/${download.source.pullRequest.head.repo.full_name}/commit/${download.source.pullRequest.head.sha}`"
              @click.stop
            >
              {{ download.source.pullRequest.head.sha.slice(0, 7) }}（{{
                download.source.pullRequest.head.repo.full_name
              }}）
            </a>
          </template>
        </template>

        <ElButton
          v-for="link in currentTargetRepo.links"
          :key="link.label"
          :type="link.buttonType"
          :href="joinUrl(`${download.pathFragment}/${link.path}`)"
          tag="a"
          target="_blank"
          >{{ link.label }}</ElButton
        >
        <ElButton
          v-if="
            download.source.type === 'branch' &&
            hasRelease(previewData.releases, download.source.branch.name)
          "
          type="primary"
          :href="releasePageUrl(download.source.branch.name)"
          tag="a"
          >リリース</ElButton
        >
      </ElCard>
    </template>
    <template v-else>
      <ElCard
        v-for="release in filterReleases(previewData.releases)"
        :key="release.branch"
        class="download-card"
      >
        <template #header>
          <ElTag type="primary" disableTransitions>Branch</ElTag>
          <a
            class="download-source"
            :href="`https://github.com/${targetRepos[currentRepo].repo}/tree/${release.branch}`"
            @click.stop
          >
            {{ release.branch }}
          </a>
          ：
          <a
            :href="`https://github.com/${targetRepos[currentRepo].repo}/commit/${release.commitSha}`"
            @click.stop
          >
            {{ release.commitSha.slice(0, 7) }}
          </a>
        </template>

        <ElButton type="primary" :href="releasePageUrl(release.branch)" tag="a"
          >リリース</ElButton
        >
      </ElCard>
    </template>
  </section>
</template>

<script setup lang="ts">
import {
  ElButton,
  ElButtonGroup,
  ElCard,
  ElLoading,
  ElTag,
} from "element-plus";
import { computed } from "vue";
import { TargetRepoKey } from "../../scripts/common.ts";
import { ReleaseData, targetRepos } from "../../scripts/constants.ts";
import { usePreviewData } from "../composables/usePreviewData.ts";

const currentRepo = defineModel<TargetRepoKey>("currentRepo", {
  required: true,
});
const previewData = usePreviewData();

const switchRepo = (repo: TargetRepoKey) => {
  currentRepo.value = repo;
};

const currentTargetRepo = computed(() => targetRepos[currentRepo.value]);
const filterReleases = (releases: ReleaseData[]) =>
  releases.filter((release) => release.repoKey === currentRepo.value);
const hasRelease = (releases: ReleaseData[], branch: string) =>
  filterReleases(releases).some((release) => release.branch === branch);

const releasePageUrl = (branch: string) =>
  `${location.pathname}?${new URLSearchParams({ repo: currentRepo.value, release: branch }).toString()}`;
const joinUrl = (path: string) =>
  `${import.meta.env.BASE_URL}/preview/${path}`.replace(/\/+/g, "/");
</script>

<style scoped lang="scss">
.download-source {
  padding-left: 0.5rem;
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
