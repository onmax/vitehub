<script setup lang="ts">
import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsSectionForPath,
  getDocsSidebarGroups,
  type DocsSidebarGroup,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const currentPath = computed(() => normalizeDocsPath(route.path));
const section = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
const pageGroups = computed(() => section.value ? getDocsSidebarGroups(section.value) : []);

function isActive(path: string) {
  return currentPath.value === normalizeDocsPath(path);
}

function isPageGroupOpen(group: DocsSidebarGroup, index: number) {
  return group.pages.some(page => isActive(page.path)) || index === 0;
}
</script>

<template>
  <nav v-if="section" class="vh-docs-sidebar-nav" :aria-label="`${section.title} pages`">
    <template v-for="(pageGroup, groupIndex) in pageGroups" :key="pageGroup.label || 'pages'">
      <details
        v-if="pageGroup.label"
        class="vh-docs-sidebar-page-group group/page-group"
        :open="isPageGroupOpen(pageGroup, groupIndex)"
      >
        <summary class="vh-docs-sidebar-page-group-summary">
          <span class="min-w-0 truncate">{{ pageGroup.label }}</span>
          <UIcon name="i-ph-caret-down-light" class="ml-auto size-3 shrink-0 group-open/page-group:rotate-180" />
        </summary>

        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          :class="['vh-docs-sidebar-link is-grouped', { 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <UIcon :name="sidebarPageIcon(page)" class="size-4 shrink-0" />
          <span class="min-w-0 truncate">{{ page.title }}</span>
        </NuxtLink>
      </details>

      <template v-else>
        <NuxtLink
          v-for="page in pageGroup.pages"
          :key="page.path"
          :to="page.path"
          :class="['vh-docs-sidebar-link', { 'is-active': isActive(page.path) }]"
          :aria-current="isActive(page.path) ? 'page' : undefined"
        >
          <UIcon :name="sidebarPageIcon(page)" class="size-4 shrink-0" />
          <span class="min-w-0 truncate">{{ page.title }}</span>
        </NuxtLink>
      </template>
    </template>

    <NuxtLink to="/docs" class="vh-docs-sidebar-link vh-docs-sidebar-catalog-link">
      <UIcon name="i-ph-squares-four-light" class="size-4 shrink-0" />
      <span class="min-w-0 truncate">All products</span>
    </NuxtLink>
  </nav>
</template>

<style scoped>
.vh-docs-sidebar-nav {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0.5rem 0 0;
}

.vh-docs-sidebar-page-group {
  border-top: 1px solid color-mix(in srgb, var(--ui-border) 65%, transparent);
}

.vh-docs-sidebar-page-group:first-child {
  border-top: 0;
}

.vh-docs-sidebar-page-group-summary {
  display: flex;
  cursor: pointer;
  list-style: none;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem 0.375rem;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-docs-sidebar-page-group-summary::-webkit-details-marker {
  display: none;
}

.vh-docs-sidebar-page-group-summary:hover,
.vh-docs-sidebar-page-group-summary:focus-visible {
  color: var(--ui-text);
}

.vh-docs-sidebar-link {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  border-left: 2px solid transparent;
  padding: 0.25rem 1.25rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
}

.vh-docs-sidebar-link.is-grouped {
  padding-left: 2rem;
}

.vh-docs-sidebar-link:hover,
.vh-docs-sidebar-link:focus-visible,
.vh-docs-sidebar-link.is-active {
  border-left-color: var(--ui-text-highlighted);
  background: color-mix(in srgb, var(--ui-text-highlighted) 6%, transparent);
  color: var(--ui-text);
}

.vh-docs-sidebar-catalog-link {
  margin-top: 0.75rem;
  border-top: 1px solid var(--ui-border);
  padding-top: 0.625rem;
  padding-bottom: 0.625rem;
  color: var(--ui-text-dimmed);
  font-size: 0.8125rem;
}
</style>
