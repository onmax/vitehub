<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import type { VNode } from "vue";
import type { ContentPage } from "../composables/useDocsPage";

const props = defineProps<{
  page: ContentPage;
}>();

const tree = ref<Record<string, unknown>>({});
const activePath = ref("");
provide("codeTree", tree);
provide("codeTreeActive", activePath);

watch(() => props.page.path, () => {
  tree.value = {};
  activePath.value = "";
});

const treeItems = computed(() => Object.entries(tree.value)
  .filter((entry): entry is [string, VNode] => isVNode(entry[1]))
  .map(([label, component]) => ({ label, component })));

function selectCodePath(path?: string) {
  if (path && treeItems.value.some(item => item.label === path)) activePath.value = path;
}

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value;
}

const pageUi = {
  root: "grid w-full max-w-none grid-cols-1 gap-8 px-0 lg:!grid-cols-1 lg:!gap-8 xl:!grid-cols-[minmax(0,1fr)_minmax(20rem,42%)] xl:!gap-8 2xl:!gap-10",
  center: "min-w-0 max-w-none mx-0 xl:col-span-1",
  // UPage gives the right slot the global TOC width by default. Tutorials use
  // the wider code rail from the grid above, so explicitly let this slot fill
  // its track instead of silently collapsing to --vh-toc-width.
  right: "hidden xl:col-span-1 xl:order-none xl:block xl:!w-full xl:!max-w-none w-full min-w-0 self-stretch border-l border-default",
};

const pageHeaderUi = {
  root: "!px-0 pb-8 sm:!px-0 lg:!px-0 xl:!px-0",
  container: "max-w-[54rem]",
  description: "max-w-[42rem]",
};

const codeTreeUi = {
  root: "my-0 min-h-0 flex-1 h-auto w-full rounded-none border-0 xl:!h-auto xl:!grid-cols-[minmax(9rem,30%)_minmax(0,1fr)]",
  list: "h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain border-default p-1 pr-2",
  listWithChildren: "ms-3 border-s border-default",
  itemWithChildren: "ps-1 -ms-px",
  link: "min-w-0 px-1.5 py-1.5 gap-1.5",
  linkLabel: "min-w-0 truncate",
  content: "h-full min-w-0 overflow-hidden xl:!col-span-1 xl:!col-start-2 xl:!row-start-1 [&>div]:m-0 [&>div]:h-full [&>div]:min-h-0 [&>div]:w-full [&>div]:!overflow-hidden [&>div>pre]:min-h-0 [&>div>pre]:w-full [&>div>pre]:max-w-none [&>div>pre]:flex-1 [&>div>pre]:overflow-auto [&>div>pre]:bg-muted/50 [&>div>pre]:border-default [&>div>pre]:rounded-none [&>div>pre]:px-3 [&>div>pre]:py-3",
};
</script>

<template>
  <UPage :ui="pageUi">
    <UPageHeader :title="props.page.title" :description="props.page.description" :ui="pageHeaderUi">
      <template #links>
        <DocsPageHeaderLinks />
      </template>
    </UPageHeader>

    <UPageBody prose class="docs-content docs-tutorial-content max-w-none !px-0 sm:!px-0 lg:!px-0 xl:!px-0 pb-24">
      <ContentRenderer :value="props.page" />
    </UPageBody>

    <template #right>
      <aside class="vh-tutorial-code-panel" aria-label="Tutorial files and code">
        <div class="vh-tutorial-code-heading">
          <span>Files and code</span>
          <span v-if="activePath" class="vh-tutorial-code-current">{{ activePath }}</span>
        </div>
        <div class="sr-only" aria-live="polite" aria-atomic="true">
          <span v-if="activePath">Showing {{ activePath }}</span>
        </div>
        <ProseCodeTree
          v-if="activePath && treeItems.length"
          :model-value="activePath"
          @update:model-value="selectCodePath"
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

.vh-tutorial-code-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0.625rem 0.875rem;
  color: var(--ui-text-dimmed);
  font: 600 0.6875rem/1.2 var(--font-mono, ui-monospace);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.vh-tutorial-code-current {
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-muted);
  font-weight: 500;
  letter-spacing: 0;
  text-overflow: ellipsis;
  text-transform: none;
  white-space: nowrap;
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

@media (max-width: 79.99rem) {
  .docs-tutorial-content {
    padding-inline: 0;
  }
}
</style>
