<script setup lang="ts">
import type { ContentPage } from "../composables/useDocsPage";
import type { DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";

// The Markdown body opens with `::product-hero` and continues with `::product-features`.
// This component appends the footer that lists every package.
defineProps<{
  page: ContentPage;
  section: DocsSection;
}>();
</script>

<template>
  <article class="vh-product-landing">
    <div class="vh-product-actions">
      <DocsPageHeaderLinks />
    </div>

    <UPageBody prose class="docs-content vh-product-body !px-0">
      <ContentRenderer :value="page" />
    </UPageBody>

    <DocsProductFooter :current="section" />
  </article>
</template>

<style scoped>
.vh-product-landing {
  padding-bottom: 4rem;
}

.vh-product-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 1rem;
}

/* The landing body spans the full landing width. Its sections manage their own measure. */
.vh-product-body {
  max-width: none;
  padding-bottom: 0;
}
</style>
