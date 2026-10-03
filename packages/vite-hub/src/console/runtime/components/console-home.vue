<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleSectionId } from "../sections";
import { resolveConsoleRouteName } from "../console-route";
import type { ConsoleNavigation } from "../client/sections";
import {
  prioritizeConsoleSectionIds,
  readLastConsoleSection,
} from "../sections";
import { loadConsoleNavigation, resolveConsoleSectionDetails } from "../client/sections";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleSectionNav from "./console-section-nav.vue";
import ConsoleSearch from "./console-search.vue";
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const sections = ref<ConsoleSectionId[]>([]);
const installedNavigation = shallowRef<ConsoleNavigation>();
const lastSection = ref<ConsoleSectionId>();
const loading = ref(true);
const error = ref<unknown>();
let request = 0;

const availableSections = computed(() =>
  prioritizeConsoleSectionIds(sections.value, lastSection.value).flatMap((section) => {
    const details = resolveConsoleSectionDetails(installedNavigation.value, section);
    return details ? [{ id: section, ...details }] : [];
  }),
);
const sidebarSections = computed(() =>
  availableSections.value.filter((section) => section.id !== "usage"),
);

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The console could not load its configuration.";
}

async function loadSections(): Promise<void> {
  const currentRequest = ++request;
  loading.value = true;
  try {
    const navigation = await loadConsoleNavigation(props.sectionsBase);
    if (!navigation) throw viteHubErrorDiagnostics.VITE_HUB_R0101({ message: "The console could not load its configuration." });
    if (request !== currentRequest) return;
    installedNavigation.value = navigation;
    sections.value = [...new Set(navigation.sections)];
    error.value = undefined;
  } catch (requestError) {
    if (request === currentRequest) error.value = requestError;
  } finally {
    if (request === currentRequest) loading.value = false;
  }
}

async function openSection(routeName: string): Promise<void> {
  sidebarOpen.value = false;
  await router.push({ name: resolveConsoleRouteName(route.name, routeName) });
}

onMounted(() => {
  lastSection.value = readLastConsoleSection();
  void loadSections();
});
onBeforeUnmount(() => request++);
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="console-navigation"
      class="vitehub-console__nav"
      v-model:open="sidebarOpen"
      :default-size="16"
      :collapsed-size="4"
      :min-size="13"
      :max-size="26"
      :menu="{ title: 'ViteHub', description: 'Choose a section.' }"
      :ui="{ body: 'gap-0 overflow-hidden p-0', footer: 'shrink-0 border-t border-default px-2 py-1.5' }"
      resizable
    >
      <template #header="{ collapsed }">
        <ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>

      <template #default="{ collapsed }">
        <div v-if="error && !collapsed" class="px-3 pb-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-ph-cloud-slash-light"
            title="Could not load sections"
            :description="errorMessage(error)"
            :actions="[
              { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadSections },
            ]"
          />
        </div>
        <div class="flex shrink-0 items-center gap-0.5 px-2 pb-1.5">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="vitehub-console__search min-w-0 flex-1 rounded-md bg-transparent px-2 ring-0 hover:bg-elevated/60"
            label="Search"
          />
        </div>
        <ConsoleSectionNav :collapsed="collapsed" :sections-base="sectionsBase" @navigate="sidebarOpen = false" />
        <p v-if="!loading && !error && !sidebarSections.length && !collapsed" class="px-4 text-sm leading-6 text-muted">
          Enable Agents, Blob, Database, KV, Rate Limit, Sandbox, Workspace, Workflow, Queue, or Schedule in the ViteHub configuration to add a section.
        </p>
      </template>

      <template #footer="{ collapsed }">
        <ConsolePrimitiveSwitcher :collapsed="collapsed" :sections-base="sectionsBase" />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel id="console-home" :ui="{ body: 'min-h-0 overflow-y-auto p-0 gap-0' }">
      <template #header>
        <UDashboardNavbar title="Overview" :toggle="{ 'aria-label': 'Open sections' }" :ui="{ root: 'border-0' }" />
      </template>

      <template #body>
        <main class="px-5 pb-16 pt-6 sm:px-8">
          <div class="mx-auto w-full max-w-3xl">
            <header class="mb-6">
              <h1 class="text-xl font-semibold tracking-tight text-highlighted">
                {{ installedNavigation?.projectName || "ViteHub Console" }}
              </h1>
              <p class="mt-1 text-sm text-muted">
                {{ loading ? "Loading the enabled primitives…" : `${availableSections.length} ${availableSections.length === 1 ? "primitive" : "primitives"} enabled for this project.` }}
              </p>
            </header>

            <div v-if="loading" class="grid gap-px">
              <USkeleton v-for="index in 5" :key="index" class="h-12 rounded-md" />
            </div>
            <ul v-else-if="availableSections.length" class="vitehub-console__directory grid gap-px">
              <li v-for="section in availableSections" :key="section.id">
                <button
                  class="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  type="button"
                  :aria-label="`Open ${section.label}`"
                  @click="openSection(section.routeName)"
                >
                  <UIcon :name="section.icon" class="size-4 shrink-0 text-muted opacity-80" />
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium text-highlighted">{{ section.label }}</span>
                    <span class="block truncate text-xs text-muted">{{ section.description }}</span>
                  </span>
                  <UIcon name="i-lucide-chevron-right" class="size-3.5 shrink-0 text-dimmed opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                </button>
              </li>
            </ul>
            <UAlert
              v-else-if="error"
              color="error"
              variant="subtle"
              icon="i-ph-cloud-slash-light"
              title="Could not load sections"
              :description="errorMessage(error)"
              :actions="[
                { label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: loadSections },
              ]"
            />
            <UEmpty
              v-else
              class="min-h-72"
              icon="i-ph-layout-light"
              title="No primitives enabled"
              description="Enable Agents, Blob, Database, KV, Rate Limit, Sandbox, Workspace, Workflow, Queue, or Schedule in the ViteHub configuration to add a Console page."
            />
          </div>
        </main>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>
