<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { useRoute } from "vue-router"

import { loadConsoleNavigation, subscribeConsoleNavigation } from "../client/sections"
import { resolveConsoleRouteName } from "../console-route"
import ConsoleMark from "./console-mark.vue"

const props = defineProps<{
  collapsed?: boolean
  sectionsBase: string
}>()

const projectName = ref<string>()
const route = useRoute()
let unsubscribeNavigation: (() => void) | undefined

onMounted(async () => {
  unsubscribeNavigation = subscribeConsoleNavigation(props.sectionsBase, (navigation) => {
    projectName.value = navigation.projectName
  })
  projectName.value = (await loadConsoleNavigation(props.sectionsBase))?.projectName
})

onBeforeUnmount(() => unsubscribeNavigation?.())
</script>

<template>
  <RouterLink
    class="vitehub-console__brand flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm font-medium text-highlighted hover:bg-elevated/60"
    :class="collapsed ? 'justify-center' : ''"
    :to="{ name: resolveConsoleRouteName(route.name, 'vitehub-console') }"
    :aria-label="projectName ? `${projectName} overview` : 'ViteHub overview'"
  >
    <ConsoleMark class="size-4 shrink-0" />
    <span v-if="!collapsed" class="min-w-0 truncate">{{ projectName || "ViteHub" }}</span>
  </RouterLink>
</template>
