<script setup lang="ts">
import { normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";

const route = useRoute();
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
// The catalog is the only centered landing page. Product overviews keep the package selector and sidebar.
const isCatalog = computed(() => normalizeDocsPath(route.path) === "/docs");

// On docs pages the sidebar sits on the left edge of the viewport. The page content centers in the remaining space.
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!items-start lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
};
</script>

<template>
  <UMain>
    <UContainer v-if="isSupportMatrix">
      <AnnouncementBanner />
      <slot />
    </UContainer>

    <div v-else-if="isCatalog" class="vh-docs-landing">
      <slot />
    </div>

    <UPage v-else :ui="docsShellUi">
      <template #left>
        <UPageAside class="vh-docs-aside">
          <DocsAsideLeftTop />
          <DocsAsideLeftBody />
        </UPageAside>
      </template>

      <div class="vh-docs-main">
        <AnnouncementBanner />
        <slot />
      </div>
    </UPage>
  </UMain>
</template>

<style scoped>
.vh-docs-main,
.vh-docs-landing {
  margin: 0 auto;
  padding: 0 1rem;
}

.vh-docs-main {
  width: 100%;
  max-width: none;
}

.vh-docs-landing {
  max-width: var(--vh-landing-width);
}

@media (min-width: 40rem) {
  .vh-docs-main,
  .vh-docs-landing {
    padding: 0 2rem;
  }
}

@media (min-width: 64rem) {
  .vh-docs-aside {
    position: sticky;
    top: var(--ui-header-height);
    display: flex;
    height: calc(100dvh - var(--ui-header-height));
    max-height: calc(100dvh - var(--ui-header-height));
    min-height: calc(100dvh - var(--ui-header-height));
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--ui-border);
  }
}
</style>
