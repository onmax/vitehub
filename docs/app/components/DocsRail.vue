<script setup lang="ts">
import { PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem } from "@vite-hub/ui/primitive-rail";
import { NuxtLink } from "#components";
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsCatalog,
  getDocsSectionForPath,
  getUncategorizedDocsSections,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const route = useRoute();
const currentSection = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
// One rail group for each catalog category. Sections without a category stay reachable in a last group.
const groups = [
  ...getDocsCatalog(docsManifest.sections).map((group) => group.sections),
  getUncategorizedDocsSections(docsManifest.sections),
].filter((sections) => sections.length > 0);
</script>

<template>
  <PrimitiveRail label="Docs sections">
    <PrimitiveRailGroup v-for="(sections, index) in groups" :key="index">
      <UTooltip
        v-for="section in sections"
        :key="section.id"
        :text="section.title"
        :content="{ side: 'right', sideOffset: 6 }"
        :delay-duration="150"
      >
        <PrimitiveRailItem
          :as="NuxtLink"
          :to="section.path"
          :current="section.id === currentSection?.id"
          :icon="railSectionIcon(section)"
          :label="section.title"
        />
      </UTooltip>
    </PrimitiveRailGroup>
  </PrimitiveRail>
</template>
