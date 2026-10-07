<script setup lang="ts">
import { computed, provide, ref } from "vue";
import type { VNode } from "vue";
import type { ContentPage } from "../composables/useDocsPage";

const props = defineProps<{
  page: ContentPage;
}>();

const tree = ref<Record<string, unknown>>({});
const activePath = ref("");
provide("codeTree", tree);
provide("codeTreeActive", activePath);

const treeItems = computed(() => Object.entries(tree.value)
  .filter((entry): entry is [string, VNode] => isVNode(entry[1]))
  .map(([label, component]) => ({ label, component })));

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value;
}

const pageUi = {
  root: "grid w-full max-w-none grid-cols-1 gap-8 px-0 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,42%)] lg:gap-8 xl:gap-10",
  center: "min-w-0 max-w-none mx-0 lg:col-span-1",
  right: "hidden lg:col-span-1 lg:order-none lg:block w-full min-w-0 self-stretch border-l border-default",
};

const pageHeaderUi = {
  root: "px-0 pb-8",
  container: "max-w-[54rem]",
  description: "max-w-[42rem]",
};

const codeTreeUi = {
  root: "my-0 h-full min-h-0 w-full rounded-none border-0 lg:!grid-cols-[minmax(9rem,30%)_minmax(0,1fr)]",
  list: "h-full min-h-0 border-default p-1 pr-2",
  listWithChildren: "ms-3 border-s border-default",
  itemWithChildren: "ps-1 -ms-px",
  link: "px-1.5 py-1.5 gap-1.5",
  content: "h-full min-w-0 lg:!col-span-1 lg:!col-start-2 lg:!row-start-1 [&>div]:m-0 [&>div]:h-full [&>div]:min-h-0 [&>div]:w-full [&>div]:!overflow-hidden [&>div>pre]:min-h-0 [&>div>pre]:w-full [&>div>pre]:max-w-none [&>div>pre]:flex-1 [&>div>pre]:overflow-auto [&>div>pre]:bg-muted/50 [&>div>pre]:border-default [&>div>pre]:rounded-none [&>div>pre]:px-3 [&>div>pre]:py-3",
};
</script>

<template>
  <UPage :ui="pageUi">
    <UPageHeader :title="props.page.title" :description="props.page.description" :ui="pageHeaderUi">
      <template #links>
        <DocsPageHeaderLinks />
      </template>
    </UPageHeader>

    <UPageBody prose class="docs-content docs-tutorial-content max-w-none pb-24">
      <ContentRenderer :value="props.page" />
    </UPageBody>

    <template #right>
      <aside class="vh-tutorial-code-panel">
        <ProseCodeTree
          v-if="activePath && treeItems.length"
          v-model="activePath"
          :items="treeItems"
          expand-all
          :ui="codeTreeUi"
        />
        <div v-else class="vh-tutorial-code-empty">
          <UIcon name="i-lucide-arrow-down" class="size-8" aria-hidden="true" />
          <span>Scroll to follow the code</span>
        </div>
      </aside>
    </template>
  </UPage>
</template>

<style scoped>
.docs-tutorial-content {
  width: 100%;
  max-width: none;
  padding-inline: 0;
}

.docs-tutorial-content :deep(> div > h1:first-child) {
  display: none;
}

.docs-tutorial-content :deep(> div > :not(.vh-tutorial-step)) {
  max-width: 54rem;
}

.vh-tutorial-code-panel {
  position: sticky;
  top: var(--ui-header-height);
  display: flex;
  height: calc(100dvh - var(--ui-header-height));
  min-height: 32rem;
  flex-direction: column;
  overflow: hidden;
}

.vh-tutorial-code-empty {
  display: grid;
  flex: 1;
  place-content: center;
  gap: 0.75rem;
  color: var(--ui-text-dimmed);
  font-size: 0.8125rem;
  text-align: center;
}

@media (max-width: 63.99rem) {
  .docs-tutorial-content {
    padding-inline: 0;
  }
}
</style>
