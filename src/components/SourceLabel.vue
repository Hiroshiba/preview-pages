<template>
  <template v-if="source.type === 'branch'">
    <ElTag type="primary" disableTransitions>Branch</ElTag>
    <a
      class="download-source"
      :href="`https://github.com/${repo}/tree/${source.branch.name}`"
      @click.stop
    >
      {{ source.branch.name }}
    </a>
    ：
    <a
      :href="`https://github.com/${repo}/commit/${source.branch.commit.sha}`"
      @click.stop
    >
      {{ source.branch.commit.sha.slice(0, 7) }}
    </a>
  </template>
  <template v-if="source.type === 'pullRequest'">
    <ElTag type="success" disableTransitions>Pull Request</ElTag>
    <a class="download-source" :href="source.pullRequest.html_url" @click.stop>
      #{{ source.pullRequest.number }} （{{ source.pullRequest.title }}）
    </a>
    ：
    <a
      :href="`https://github.com/${source.pullRequest.head.repo.full_name}/commit/${source.pullRequest.head.sha}`"
      @click.stop
    >
      {{ source.pullRequest.head.sha.slice(0, 7) }}（{{
        source.pullRequest.head.repo.full_name
      }}）
    </a>
  </template>
</template>

<script setup lang="ts">
import { ElTag } from "element-plus";
import type { Source } from "../../scripts/constants.ts";

defineProps<{
  source: Source;
  repo: string;
}>();
</script>

<style scoped lang="scss">
.download-source {
  padding-left: 0.5rem;
}
</style>
