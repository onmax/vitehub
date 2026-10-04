<script setup lang="ts">
// `::agent-demo` in Markdown mounts the interactive Agent playground from the site landing page.
import { MotionConfig } from "motion-v";
import AgentPlayground from "../landing/AgentPlayground.vue";
</script>

<template>
  <div class="not-prose vh-agent-demo">
    <ClientOnly>
      <MotionConfig reduced-motion="user">
        <AgentPlayground class="min-w-0" />
      </MotionConfig>
      <template #fallback>
        <div class="min-h-[32rem]" />
      </template>
    </ClientOnly>
  </div>
</template>

<style scoped>
.vh-agent-demo {
  margin: 2rem 0;
}
</style>
