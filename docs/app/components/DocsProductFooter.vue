<script setup lang="ts">
// The footer of a product landing page: every product by category, with the current one marked.
import { docsManifest, type DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsCatalog } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const props = defineProps<{
  current: DocsSection;
}>();

// The Start row lists guides, not products. Platform sections stay reachable from the header and the catalog.
const groups = getDocsCatalog(docsManifest.sections).filter(group => group.category !== "Start" && group.category !== "Platform");

function isCurrent(section: DocsSection) {
  return section.id === props.current.id;
}

function isRelated(section: DocsSection) {
  return props.current.related.includes(section.id);
}
</script>

<template>
  <footer class="vh-product-footer" aria-label="All products">
    <div class="vh-product-footer-head">
      <h2 class="vh-product-footer-title">All products</h2>
      <NuxtLink to="/docs" class="vh-product-footer-catalog group">
        Product catalog
        <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
      </NuxtLink>
    </div>

    <div class="vh-product-footer-grid">
      <section v-for="group in groups" :key="group.category" class="vh-product-footer-group">
        <h3 class="vh-product-footer-category">{{ group.category }}</h3>
        <ul class="vh-product-footer-list">
          <li v-for="section in group.sections" :key="section.id">
            <NuxtLink
              :to="section.path"
              class="vh-product-footer-link"
              :class="{ 'is-current': isCurrent(section), 'is-related': isRelated(section) }"
              :aria-current="isCurrent(section) ? 'page' : undefined"
            >
              <UIcon :name="sidebarSectionIcon(section)" class="size-4 shrink-0" />
              <span class="min-w-0 truncate">{{ section.title }}</span>
              <span v-if="isRelated(section)" class="vh-product-footer-tag">related</span>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>
  </footer>
</template>

<style scoped>
.vh-product-footer {
  margin-top: 4rem;
}

.vh-product-footer-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.vh-product-footer-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.vh-product-footer-catalog {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  font-weight: 500;
  transition: color 150ms ease;
}

.vh-product-footer-catalog:hover {
  color: var(--ui-text-highlighted);
}

.vh-product-footer-catalog:hover .landing-cta-arrow {
  transform: translateX(0.25rem);
}

.vh-product-footer-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.5rem 2rem;
}

@media (min-width: 48rem) {
  .vh-product-footer-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 64rem) {
  .vh-product-footer-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

.vh-product-footer-category {
  margin: 0 0 0.5rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-product-footer-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.vh-product-footer-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.1875rem 0;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.375rem;
  transition: color 150ms ease;
}

.vh-product-footer-link:hover {
  color: var(--ui-text-highlighted);
}

.vh-product-footer-link.is-current {
  color: var(--ui-text-highlighted);
  font-weight: 500;
}

.vh-product-footer-tag {
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 0.625rem;
}
</style>
