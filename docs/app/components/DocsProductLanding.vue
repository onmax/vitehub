<script setup lang="ts">
import type { ContentPage } from "../composables/useDocsPage";
import { docsManifest, type DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsRelatedSections, getDocsSectionSubpages, getDocsSidebarGroups } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const props = defineProps<{
  page: ContentPage;
  section: DocsSection;
}>();

// The Markdown body opens with `::product-hero` and continues with `::product-feature` sections.
// This component appends the page index and the related products.
const subpages = computed(() => getDocsSectionSubpages(props.section));
// Sections with sidebar groups, such as Agents, list their pages by group instead of one card per page.
const pageGroups = computed(() => getDocsSidebarGroups(props.section).filter(group => group.label));
const related = computed(() => getDocsRelatedSections(docsManifest.sections, props.section));
</script>

<template>
  <article class="vh-product-landing">
    <UPageBody prose class="docs-content vh-product-body">
      <ContentRenderer :value="page" />
    </UPageBody>

    <section class="vh-product-index" aria-label="Product pages">
      <div class="vh-product-index-head">
        <h2 class="vh-product-index-title">Read the {{ section.title }} docs</h2>
        <DocsPageHeaderLinks />
      </div>

      <nav v-if="pageGroups.length" aria-label="Product pages" class="vh-product-groups">
        <section v-for="group in pageGroups" :key="group.label || 'pages'" class="vh-product-group">
          <h3 class="vh-product-group-heading">{{ group.label }}</h3>
          <NuxtLink
            v-for="subpage in group.pages"
            :key="subpage.path"
            :to="subpage.path"
            class="vh-product-group-link"
          >
            <UIcon :name="sidebarPageIcon(subpage)" class="size-4 shrink-0" />
            <span class="min-w-0 truncate">{{ subpage.title }}</span>
          </NuxtLink>
        </section>
      </nav>

      <nav v-else-if="subpages.length" aria-label="Product pages" class="vh-product-pages">
        <NuxtLink
          v-for="subpage in subpages"
          :key="subpage.path"
          :to="subpage.path"
          class="vh-product-page group"
        >
          <UIcon :name="sidebarPageIcon(subpage)" class="size-4 shrink-0 text-muted transition-colors group-hover:text-highlighted" />
          <span class="min-w-0">
            <span class="vh-product-page-title">{{ subpage.title }}</span>
            <span v-if="subpage.description" class="vh-product-page-description">{{ subpage.description }}</span>
          </span>
        </NuxtLink>
      </nav>
    </section>

    <footer v-if="related.length" class="vh-product-related">
      <h2 class="vh-product-related-heading">Related</h2>
      <div class="vh-product-related-list">
        <NuxtLink
          v-for="relatedSection in related"
          :key="relatedSection.id"
          :to="relatedSection.path"
          class="vh-product-related-link"
        >
          <UIcon :name="sidebarSectionIcon(relatedSection)" class="size-4 shrink-0" />
          <span>{{ relatedSection.title }}</span>
        </NuxtLink>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.vh-product-landing {
  padding-bottom: 4rem;
}

/* The landing body spans the full landing width. Its sections manage their own measure. */
.vh-product-body {
  max-width: none;
  padding-bottom: 0;
}

.vh-product-index {
  padding-top: 3rem;
}

.vh-product-index-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.vh-product-index-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

/* Each card draws its right and bottom line, so a short last row leaves no filler cells. */
.vh-product-pages {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-top: 1px solid var(--ui-border);
  border-left: 1px solid var(--ui-border);
}

@media (min-width: 48rem) {
  .vh-product-pages {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.vh-product-page {
  display: flex;
  gap: 0.75rem;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  padding: 1rem;
  transition: background-color 200ms ease;
}

.vh-product-page:hover {
  background: color-mix(in srgb, var(--ui-bg-muted) 35%, var(--ui-bg));
}

.vh-product-page:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.vh-product-page-title {
  display: block;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
}

.vh-product-page-description {
  display: -webkit-box;
  margin-top: 0.125rem;
  overflow: hidden;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  line-height: 1.125rem;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.vh-product-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.5rem 2rem;
}

@media (min-width: 48rem) {
  .vh-product-groups {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.vh-product-group-heading {
  margin: 0 0 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-product-group-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  transition: color 150ms ease;
}

.vh-product-group-link:hover {
  color: var(--ui-text-highlighted);
}

.vh-product-related {
  margin-top: 3rem;
  border-top: 1px solid var(--ui-border);
  padding-top: 1.5rem;
}

.vh-product-related-heading {
  margin: 0 0 0.75rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-product-related-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.5rem;
}

.vh-product-related-link {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  transition: color 150ms ease;
}

.vh-product-related-link:hover {
  color: var(--ui-text-highlighted);
}

@media (prefers-reduced-motion: reduce) {
  .vh-product-page {
    transition: none;
  }
}
</style>
