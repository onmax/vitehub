<script setup lang="ts">
import type { ContentPage } from "../composables/useDocsPage";
import { docsManifest, type DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsRelatedSections, getDocsSectionSubpages, getDocsSidebarGroups } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const props = defineProps<{
  page: ContentPage;
  section: DocsSection;
}>();

/** Products that share a looping scene with the landing page grid. */
const scenes = new Map([
  ["agents", "agent"],
  ["connections", "connections"],
  ["content", "content"],
  ["email", "email"],
  ["kv", "kv"],
  ["queue", "queue"],
  ["realtime", "realtime"],
  ["sandbox", "sandbox"],
  ["source", "source"],
  ["workflows", "workflow"],
]);

const scene = computed(() => scenes.get(props.section.id) ?? null);
const subpages = computed(() => getDocsSectionSubpages(props.section));
// Sections with sidebar groups, such as Agents, list their pages by group instead of one card per page.
const pageGroups = computed(() => getDocsSidebarGroups(props.section).filter(group => group.label));
const related = computed(() => getDocsRelatedSections(docsManifest.sections, props.section));
const getStarted = computed(() => subpages.value.find(page => page.id === "get-started") ?? subpages.value[0]);
const serverApi = computed(() => subpages.value.find(page => page.id === "server-api"));
</script>

<template>
  <article class="vh-product-landing">
    <header class="vh-product-hero">
      <div class="vh-product-hero-copy">
        <p v-if="section.category !== page.title" class="vh-product-eyebrow">
          <UIcon :name="sidebarSectionIcon(section)" class="size-4 shrink-0" />
          <span>{{ section.category }}</span>
        </p>
        <h1 class="vh-product-title">{{ page.title }}</h1>
        <p v-if="page.description" class="vh-product-description">{{ page.description }}</p>

        <div class="vh-product-actions">
          <NuxtLink
            v-if="getStarted"
            :to="getStarted.path"
            class="vh-product-cta group"
          >
            {{ getStarted.title }}
            <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
          </NuxtLink>
          <NuxtLink v-if="serverApi" :to="serverApi.path" class="vh-product-cta-secondary">
            {{ serverApi.title }}
          </NuxtLink>
          <DocsPageHeaderLinks class="ms-auto" />
        </div>
      </div>

      <div v-if="scene" class="vh-product-hero-scene" aria-hidden="true">
        <LandingPrimitiveMotion :name="scene" play />
      </div>
    </header>

    <nav v-if="pageGroups.length" class="vh-product-groups" aria-label="Product pages">
      <section v-for="group in pageGroups" :key="group.label || 'pages'" class="vh-product-group">
        <h2 class="vh-product-group-heading">{{ group.label }}</h2>
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

    <nav v-else-if="subpages.length" class="vh-product-pages" aria-label="Product pages">
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

    <UPageBody prose class="docs-content vh-product-body">
      <ContentRenderer :value="page" />
    </UPageBody>

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

.vh-product-hero {
  display: grid;
  gap: 2rem;
  align-items: center;
  padding: 3rem 0 2.5rem;
  border-bottom: 1px solid var(--ui-border);
}

@media (min-width: 64rem) {
  .vh-product-hero {
    grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
    gap: 4rem;
    padding: 4rem 0 3rem;
  }
}

.vh-product-eyebrow {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 1rem;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

.vh-product-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: clamp(2.5rem, 4.5vw, 3.75rem);
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.05;
  text-wrap: balance;
}

.vh-product-description {
  max-width: 46ch;
  margin: 1.25rem 0 0;
  color: var(--ui-text-muted);
  font-size: 1.125rem;
  line-height: 1.75rem;
  text-wrap: pretty;
}

.vh-product-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.25rem;
  margin-top: 1.75rem;
}

.vh-product-cta {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  gap: 0.375rem;
  border: 1px solid var(--ui-text-highlighted);
  background: var(--ui-text-highlighted);
  padding: 0 1rem;
  color: var(--ui-bg);
  font-size: 0.875rem;
  font-weight: 500;
}

.vh-product-cta:hover .landing-cta-arrow {
  transform: translateX(0.25rem);
}

.vh-product-cta-secondary {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  font-weight: 500;
  transition: color 150ms ease;
}

.vh-product-cta-secondary:hover {
  color: var(--ui-text-highlighted);
}

.vh-product-hero-scene {
  display: none;
  height: 8rem;
  color: var(--ui-text-muted);
}

@media (min-width: 64rem) {
  .vh-product-hero-scene {
    display: block;
  }
}

/* Each card draws its right and bottom line, so a short last row leaves no filler cells. */
.vh-product-pages {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 2rem;
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
  margin-top: 2rem;
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

.vh-product-body {
  max-width: var(--vh-content-width);
  margin-top: 2.5rem;
}

.vh-product-body :deep(h1:first-of-type) {
  display: none;
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
  .vh-product-page,
  .vh-product-cta .landing-cta-arrow {
    transition: none;
    transform: none;
  }
}
</style>
