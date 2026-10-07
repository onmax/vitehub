<script setup lang="ts">
import { useAsyncData } from "#app/composables/asyncData";
import { createError } from "#app/composables/error";
import { definePageMeta } from "#app/composables/pages";
import { useRoute } from "#app/composables/router";
import { useDocsPage } from "../../composables/useDocsPage";
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath, isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";
import {
  getDocsPageFallback,
  resolveDocsRoute,
} from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

definePageMeta({
  layout: "docs",
});

const route = useRoute();
const routeState = resolveDocsRoute(route.path);

const { data: rawDoc } = await useAsyncData(`docs:${routeState.sourcePath}`, () =>
  queryCollection("docs").path(routeState.sourcePath).first(),
);

if (!routeState.page || !rawDoc.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const { page } = useDocsPage(routeState.sourcePath, rawDoc, getDocsPageFallback(routeState.page));

const isReferencePage = computed(() => route.path.replace(/\/+$/, "") === "/docs/reference");
const isSupportMatrix = computed(
  () => route.path.replace(/\/+$/, "") === "/docs/frameworks-hosts/support-matrix",
);
const isUiPage = computed(() => {
  const path = route.path.replace(/\/+$/, "");
  return path === "/docs/ui" || path.startsWith("/docs/ui/");
});
// A product Overview is a landing page with a hero and page cards instead of the sidebar and table of contents.
const landingSection = computed(() =>
  isDocsLandingPath(docsManifest.sections, route.path) ? getDocsSectionForPath(docsManifest.sections, route.path) : null,
);
const isTutorialPage = computed(() => routeState.page?.layout === "tutorial" || page.value?.layout === "tutorial");

const docsPageUi = {
  root: "lg:!grid-cols-1 lg:!gap-0",
  center: "lg:!col-span-1",
};
</script>

<template>
  <SupportMatrix v-if="page && isSupportMatrix" />

  <DocsProductLanding v-else-if="page && landingSection" :page="page" :section="landingSection" />

  <DocsTutorial v-else-if="page && isTutorialPage" :page="page" />

  <UPage v-else-if="page" :ui="docsPageUi">
    <UPageHeader
      :title="page.title"
      :description="page.description"
      :class="{ 'docs-ui-page-shell': isUiPage }"
    >
      <template #links>
        <DocsPageHeaderLinks />
      </template>
    </UPageHeader>

    <UPageBody
      prose
      :class="[
        'docs-content pb-0',
        {
          'docs-reference-content': isReferencePage,
          'docs-ui-content docs-ui-page-shell': isUiPage,
        },
      ]"
    >
      <ContentRenderer :value="page" />
    </UPageBody>

  </UPage>
</template>

<style scoped>
.docs-content :deep(h1:first-of-type) {
  display: none;
}
</style>
