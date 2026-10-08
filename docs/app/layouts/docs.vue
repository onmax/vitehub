<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath, isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const isSupportMatrix = computed(() => normalizeDocsPath(route.path) === "/docs/frameworks-hosts/support-matrix");
// The catalog and every product Overview are landing pages: one wide centered column without a table of contents.
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));
// The rail is on every docs page. The page panel opens next to it inside a section, including its Overview.
// The support matrix keeps the full width for its table.
const hasPanel = computed(
  () => !isSupportMatrix.value && Boolean(getDocsSectionForPath(docsManifest.sections, route.path)),
);
</script>

<template>
  <UMain class="vh-docs-shell">
    <DocsSidebars class="vh-docs-desktop-nav" :panel="hasPanel" />

    <div class="vh-docs-content">
      <UContainer v-if="isSupportMatrix">
        <AnnouncementBanner />
        <slot />
      </UContainer>

      <div v-else-if="isLanding" class="vh-docs-landing">
        <slot />
      </div>

      <div v-else class="vh-docs-main">
        <AnnouncementBanner />
        <slot />
      </div>
    </div>
  </UMain>
</template>

<style scoped>
/* The header menu holds the navigation on narrow screens. The child selector outranks the DocsSidebars root rule. */
.vh-docs-shell > .vh-docs-desktop-nav {
  display: none;
}

.vh-docs-content {
  min-width: 0;
}

.vh-docs-main,
.vh-docs-landing {
  margin: 0 auto;
  padding: 0 1rem;
}

.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
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

/* On wide screens the rail and the page panel stay at the left edge. The page centers in the remaining space. */
@media (min-width: 64rem) {
  .vh-docs-shell {
    display: flex;
    align-items: flex-start;
  }

  .vh-docs-shell > .vh-docs-desktop-nav {
    position: sticky;
    top: var(--ui-header-height);
    display: flex;
    flex: none;
    height: calc(100dvh - var(--ui-header-height));
    overflow: hidden;
  }

  .vh-docs-content {
    flex: 1;
  }
}
</style>
