<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ConsoleNavigation } from "../client/sections";
import type { ConsoleSectionId } from "../sections";
import { loadConsoleNavigation, subscribeConsoleNavigation, resolveConsoleSectionDetails } from "../client/sections";
import { resolveConsoleRouteName } from "../console-route";

const props = defineProps<{
  /** Section that the current page shows. */
  active?: ConsoleSectionId;
  collapsed?: boolean;
  sectionsBase: string;
}>();
const emit = defineEmits<{ navigate: [] }>();

const route = useRoute();
const router = useRouter();
const navigation = shallowRef<ConsoleNavigation>();
const failed = ref(false);
const loading = ref(true);
let unsubscribe: (() => void) | undefined;

const sections = computed(() =>
  (navigation.value?.sections ?? []).flatMap((section) => {
    const details = resolveConsoleSectionDetails(navigation.value, section);
    return details ? [{ id: section, ...details }] : [];
  }),
);

async function load(): Promise<void> {
  failed.value = false;
  loading.value = true;
  const result = await loadConsoleNavigation(props.sectionsBase);
  if (result) navigation.value = result;
  else failed.value = true;
  loading.value = false;
}

async function open(routeName: string): Promise<void> {
  emit("navigate");
  await router.push({ name: resolveConsoleRouteName(route.name, routeName) });
}

onMounted(() => {
  unsubscribe = subscribeConsoleNavigation(props.sectionsBase, (value) => {
    navigation.value = value;
  });
  void load();
});
onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <nav class="grid gap-px px-2 pb-2" aria-label="Console sections">
    <template v-if="loading && !sections.length">
      <USkeleton v-for="index in 4" :key="index" class="h-8 rounded-md" />
    </template>
    <UButton
      v-else-if="failed && !sections.length"
      block
      class="justify-start"
      color="neutral"
      icon="i-ph-arrows-clockwise-light"
      label="Retry loading sections"
      size="sm"
      variant="ghost"
      @click="load"
    />
    <UTooltip
      v-for="section in sections"
      :key="section.id"
      :text="section.label"
      :disabled="!collapsed"
      :content="{ side: 'right' }"
    >
      <UButton
        block
        class="vitehub-console__nav-item h-8 justify-start gap-2 rounded-md px-2 text-sm"
        color="neutral"
        :icon="section.icon"
        :label="collapsed ? undefined : section.label"
        :aria-label="collapsed ? section.label : undefined"
        :aria-current="section.id === active ? 'page' : undefined"
        size="sm"
        :variant="section.id === active ? 'soft' : 'ghost'"
        @click="open(section.routeName)"
      />
    </UTooltip>
  </nav>
</template>
