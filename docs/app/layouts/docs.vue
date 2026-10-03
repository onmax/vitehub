<script setup lang="ts">
import { normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";

const route = useRoute();
const currentPath = computed(() => normalizeDocsPath(route.path));
const isSupportMatrix = computed(() => currentPath.value === "/docs/frameworks-hosts/support-matrix");
// The product catalog on `/docs` is the navigation. It has no sidebar.
const isCatalog = computed(() => currentPath.value === "/docs");
</script>

<template>
  <UMain>
    <UContainer :class="{ 'max-w-(--vh-docs-width) mx-auto': !isSupportMatrix }">
      <template v-if="isSupportMatrix">
        <AnnouncementBanner />
        <slot />
      </template>

      <UPage v-else-if="isCatalog" :ui="{ root: 'lg:!grid-cols-1 lg:!gap-0', center: 'lg:!col-span-1' }">
        <AnnouncementBanner />
        <slot />
      </UPage>

      <UPage v-else>
        <template #left>
          <UPageAside>
            <DocsAsideLeftTop />
            <DocsAsideLeftBody />
          </UPageAside>
        </template>

        <AnnouncementBanner />
        <slot />
      </UPage>
    </UContainer>
  </UMain>
</template>
