<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsCatalog, getDocsSectionForPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const currentSection = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
const sectionTitle = computed(() => currentSection.value?.title || "All products");
const sectionCategory = computed(() => {
  const category = currentSection.value?.category;
  return category || "Getting started";
});
const isDocsIndex = computed(() => normalizeDocsPath(route.path) === "/docs");
const productGroups = computed(() => getDocsCatalog(docsManifest.sections));
</script>

<template>
  <div class="vh-sidebar-head">
    <UContentSearchButton
      :collapsed="false"
      class="vh-sidebar-search"
      :ui="{
        base: 'h-10 rounded-none border-0 border-b border-default bg-muted/20 ps-5 pe-5 text-muted hover:bg-muted/40 hover:text-highlighted',
        trailing: 'ms-auto flex items-center gap-1',
      }"
    />

    <details class="vh-docs-product-picker">
      <summary class="vh-docs-context" :class="{ 'is-current': isDocsIndex }">
        <UIcon
          :name="currentSection ? sidebarSectionIcon(currentSection) : 'i-ph-squares-four-light'"
          class="size-4 shrink-0 text-muted"
        />
        <span class="vh-docs-context-copy">
          <span class="vh-docs-context-category">{{ sectionCategory }}</span>
          <span class="vh-docs-context-title">{{ sectionTitle }}</span>
        </span>
        <UIcon name="i-lucide-chevrons-up-down" class="vh-docs-context-arrow size-3.5 shrink-0" aria-hidden="true" />
      </summary>
      <div class="vh-docs-product-picker-menu">
        <NuxtLink to="/docs" class="vh-docs-product-option" :class="{ 'is-active': isDocsIndex }">
          <UIcon name="i-ph-squares-four-light" class="size-4 shrink-0" />
          <span>All documentation</span>
        </NuxtLink>
        <div v-for="group in productGroups" :key="group.category" class="vh-docs-product-group">
          <p class="vh-docs-product-group-label">{{ group.category }}</p>
          <NuxtLink
            v-for="product in group.sections"
            :key="product.id"
            :to="product.path"
            class="vh-docs-product-option"
            :class="{ 'is-active': product.id === currentSection?.id }"
          >
            <UIcon :name="sidebarSectionIcon(product)" class="size-4 shrink-0" />
            <span class="min-w-0 truncate">{{ product.title }}</span>
          </NuxtLink>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.vh-sidebar-search {
  height: 2.5rem;
  font-size: 0.875rem;
}

.vh-docs-context {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-height: 3.25rem;
  border-bottom: 1px solid var(--ui-border);
  padding: 0.5rem 1.25rem;
  color: var(--ui-text-muted);
  transition: background-color 150ms ease, color 150ms ease;
}

.vh-docs-product-picker {
  position: relative;
  border-bottom: 1px solid var(--ui-border);
}

.vh-docs-product-picker > summary {
  list-style: none;
  cursor: pointer;
}

.vh-docs-product-picker > summary::-webkit-details-marker {
  display: none;
}

.vh-docs-product-picker[open] > summary {
  border-bottom-color: transparent;
}

.vh-docs-product-picker-menu {
  position: absolute;
  z-index: 10;
  top: calc(100% - 0.25rem);
  right: 0.75rem;
  left: 0.75rem;
  max-height: min(32rem, calc(100dvh - 10rem));
  overflow-y: auto;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  box-shadow: 0 12px 32px color-mix(in srgb, #000 20%, transparent);
}

.vh-docs-product-group {
  border-top: 1px solid var(--ui-border);
  padding: 0.375rem 0;
}

.vh-docs-product-group-label {
  margin: 0;
  padding: 0.25rem 0.75rem;
  color: var(--ui-text-dimmed);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-docs-product-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
}

.vh-docs-product-option:hover,
.vh-docs-product-option:focus-visible,
.vh-docs-product-option.is-active {
  background: color-mix(in srgb, var(--ui-text-highlighted) 7%, transparent);
  color: var(--ui-text-highlighted);
}

.vh-docs-context:hover,
.vh-docs-context:focus-visible,
.vh-docs-context.is-current {
  background: color-mix(in srgb, var(--ui-text-highlighted) 5%, transparent);
  color: var(--ui-text-highlighted);
}

.vh-docs-context-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.125rem;
}

.vh-docs-context-category {
  color: var(--ui-text-dimmed);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.07em;
  line-height: 1;
  text-transform: uppercase;
}

.vh-docs-context-title {
  overflow: hidden;
  color: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vh-docs-context-arrow {
  color: var(--ui-text-dimmed);
  transition: transform 150ms ease, color 150ms ease;
}

.vh-docs-context:hover .vh-docs-context-arrow,
.vh-docs-context:focus-visible .vh-docs-context-arrow {
  color: var(--ui-text-highlighted);
  transform: translate(1px, -1px);
}
</style>
