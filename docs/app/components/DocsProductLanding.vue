<script setup lang="ts">
import type { ContentPage } from "../composables/useDocsPage";
import type { DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";

// The Markdown body opens with `::product-hero` and continues with `::product-features`.
// This component appends the footer that lists every documented area.
const props = defineProps<{
  page: ContentPage;
  section: DocsSection;
}>();

const tutorial = computed(() => props.section.pages.find(page => page.id === "get-started") || null);
</script>

<template>
  <article class="vh-product-landing">
    <div class="vh-product-actions">
      <DocsPageHeaderLinks />
    </div>

    <NuxtLink
      v-if="tutorial"
      :to="tutorial.path"
      class="vh-product-start group"
    >
      <span class="vh-product-start-copy">
        <span class="vh-product-start-label">Start here</span>
        <span class="vh-product-start-title">{{ tutorial.title }}</span>
        <span class="vh-product-start-description">Follow the first working example with code beside the explanation.</span>
      </span>
      <UIcon name="i-lucide-arrow-up-right" class="size-5 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
    </NuxtLink>

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

.vh-product-start {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 0 1.5rem;
  border: 1px solid var(--ui-border);
  padding: 1rem 1.125rem;
  color: var(--ui-text-highlighted);
  transition: background-color 150ms ease, border-color 150ms ease;
}

.vh-product-start:hover,
.vh-product-start:focus-visible {
  border-color: var(--ui-border-accented);
  background: color-mix(in srgb, var(--ui-text-highlighted) 5%, transparent);
}

.vh-product-start:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.vh-product-start-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.125rem;
}

.vh-product-start-label {
  color: var(--ui-text-dimmed);
  font: 600 0.6875rem/1.2 var(--font-mono, ui-monospace);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.vh-product-start-title {
  font-size: 1rem;
  font-weight: 600;
}

.vh-product-start-description {
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  line-height: 1.35rem;
}

/* The landing body spans the full landing width. Its sections manage their own measure. */
.vh-product-body {
  max-width: none;
  padding-bottom: 0;
}
</style>
