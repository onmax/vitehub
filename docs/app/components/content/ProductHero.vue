<script setup lang="ts">
// `::product-hero` opens a product landing page. The copy comes from the page frontmatter and the
// section manifest. The default slot renders in the right column: a `::code-group` with the real
// examples that prove the claims on the page, or an interactive component.
import { docsManifest, getDocsPageByPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath, getDocsSectionSubpages } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const props = defineProps<{
  /** Short line above the title. Defaults to the catalog category. */
  eyebrow?: string;
  /** One sentence of 20 words or fewer, shown instead of the frontmatter description. */
  tagline?: string;
}>();

const route = useRoute();
const page = computed(() => getDocsPageByPath(route.path));
const section = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
const subpages = computed(() => section.value ? getDocsSectionSubpages(section.value) : []);
const getStarted = computed(() => subpages.value.find(candidate => candidate.id === "get-started") ?? subpages.value[0]);
const serverApi = computed(() => subpages.value.find(candidate => candidate.id === "server-api"));
const eyebrow = computed(() => props.eyebrow ?? (section.value?.category !== page.value?.sourceTitle ? section.value?.category : null));
</script>

<template>
  <header class="not-prose vh-hero">
    <div class="vh-hero-copy">
      <p v-if="eyebrow" class="vh-hero-eyebrow">{{ eyebrow }}</p>
      <h1 class="vh-hero-title">{{ page?.sourceTitle || page?.title }}</h1>
      <p class="vh-hero-tagline">{{ tagline || page?.description }}</p>

      <div class="vh-hero-actions">
        <NuxtLink v-if="getStarted" :to="getStarted.path" class="vh-hero-cta group">
          {{ getStarted.title }}
          <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink v-if="serverApi" :to="serverApi.path" class="vh-hero-secondary">
          {{ serverApi.title }}
        </NuxtLink>
      </div>
    </div>

    <div class="vh-hero-panel">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.vh-hero {
  display: grid;
  gap: 2.5rem;
  align-items: center;
  padding: 3rem 0 3.5rem;
  border-bottom: 1px solid var(--ui-border);
}

@media (min-width: 64rem) {
  .vh-hero {
    grid-template-columns: minmax(20rem, 0.75fr) minmax(0, 1.25fr);
    gap: 4rem;
    padding: 4.5rem 0;
  }
}

.vh-hero-eyebrow {
  margin: 0 0 1.25rem;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

.vh-hero-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: clamp(3rem, 5vw, 4.5rem);
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1;
  text-wrap: balance;
}

.vh-hero-tagline {
  max-width: 42ch;
  margin: 1.5rem 0 0;
  color: var(--ui-text-muted);
  font-size: 1.125rem;
  line-height: 1.75rem;
  text-wrap: pretty;
}

.vh-hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.25rem;
  margin-top: 2rem;
}

.vh-hero-cta {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  gap: 0.375rem;
  background: var(--ui-text-highlighted);
  padding: 0 1rem;
  color: var(--ui-bg);
  font-size: 0.875rem;
  font-weight: 500;
}

.vh-hero-cta:hover .landing-cta-arrow {
  transform: translateX(0.25rem);
}

.vh-hero-secondary {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  font-weight: 500;
  transition: color 150ms ease;
}

.vh-hero-secondary:hover {
  color: var(--ui-text-highlighted);
}

/* The slot is a prose code block. Remove its outer margin so it fills the panel. */
.vh-hero-panel {
  min-width: 0;
}

.vh-hero-panel :deep(> *) {
  margin: 0;
}

.vh-hero-panel :deep(pre) {
  font-size: 0.8125rem;
  line-height: 1.75;
}
</style>
