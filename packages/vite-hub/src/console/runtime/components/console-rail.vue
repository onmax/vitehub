<script setup lang="ts">
import { createAuthClient } from "@vite-hub/auth/vue";
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { DropdownMenuItem } from "@nuxt/ui";
import type { ConsoleNavigation } from "../client/sections";
import type { ConsoleSectionId } from "../sections";
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances } from "../client/appearance";
import { loadConsoleNavigation, resolveConsoleSectionDetails, subscribeConsoleNavigation } from "../client/sections";
import { resolveConsoleRouteName } from "../console-route";
import { groupConsoleSections } from "../sections";
import ConsoleMark from "./console-mark.vue";

const props = defineProps<{
  /** Section that the current page shows. Leave it unset on the Overview. */
  active?: ConsoleSectionId;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const navigation = shallowRef<ConsoleNavigation>();
const navigationFailed = ref(false);
const signedIn = ref(false);
const signingOut = ref(false);
const signOutFailed = ref(false);
const accessIdentity = ref<{ label?: string; signOutURL: string }>();
const authBase = props.sectionsBase.replace(/\/sections$/, "/auth");
const authClientURL = props.sectionsBase.replace(/\/sections$/, "/client.js");
const signInURL = props.sectionsBase.replace(/\/api\/_vitehub\/console\/sections$/, "/_vitehub/sign-in");
let authClientRequest: Promise<ReturnType<typeof createAuthClient>> | undefined;
let unsubscribe: (() => void) | undefined;

const projectName = computed(() => navigation.value?.projectName || "ViteHub");
const groups = computed(() =>
  groupConsoleSections(
    (navigation.value?.sections ?? []).flatMap((section) => {
      const details = resolveConsoleSectionDetails(navigation.value, section);
      return details ? [{ id: section, ...details }] : [];
    }),
  ),
);
// The standalone Console provides its appearance. A Nuxt host owns color mode, so the rail hides the control there.
const appearance = inject(consoleAppearanceKey, undefined);
const currentAppearance = computed(() => consoleAppearanceOptions[appearance?.preference.value ?? "system"]);
const appearanceLabel = computed(() => `Appearance: ${currentAppearance.value.label}`);
const appearanceItems = computed<DropdownMenuItem[]>(() => [
  { type: "label", label: "Appearance" },
  ...consoleAppearances.map((option): DropdownMenuItem => ({
    type: "checkbox",
    icon: consoleAppearanceOptions[option].icon,
    label: consoleAppearanceOptions[option].label,
    checked: appearance?.preference.value === option,
    onSelect: () => appearance?.select(option),
  })),
]);
const signOutLabel = computed(() => (accessIdentity.value?.label ? `Sign out ${accessIdentity.value.label}` : "Sign out"));

async function open(routeName: string): Promise<void> {
  await router.push({ name: resolveConsoleRouteName(route.name, routeName) });
}

async function loadNavigation(): Promise<void> {
  navigationFailed.value = false;
  const result = await loadConsoleNavigation(props.sectionsBase);
  if (!result) {
    navigationFailed.value = true;
    return;
  }
  navigation.value = result;
  if (result.auth === "cloudflare-access") void loadAccessIdentity();
  else if (result.auth) void loadAuthSession();
}

async function loadAccessIdentity(): Promise<void> {
  try {
    const response = await fetch(`${authBase}/identity`, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Identity request failed");
    // SAFETY: Reading optional properties is safe for any JSON value; each value is validated below.
    const identity = (await response.json()) as { commonName?: unknown; email?: unknown; signOutURL?: unknown } | null;
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The identity response is untrusted JSON, so validate the same-origin sign-out path.
    if (typeof identity?.signOutURL !== "string" || !identity.signOutURL.startsWith("/") || identity.signOutURL.startsWith("//")) throw new Error("Invalid identity");
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The identity response is untrusted JSON, so validate each label before rendering it.
    const label = typeof identity.email === "string" ? identity.email : typeof identity.commonName === "string" ? identity.commonName : undefined;
    accessIdentity.value = { label, signOutURL: identity.signOutURL };
    signedIn.value = true;
  } catch {
    accessIdentity.value = undefined;
    signedIn.value = false;
  }
}

async function consoleAuthClient(): Promise<ReturnType<typeof createAuthClient>> {
  authClientRequest ??= import(/* @vite-ignore */ authClientURL)
    .then(() => {
      // SAFETY: The generated Console Auth client script is the only writer for this symbol and stores a createAuthClient result.
      return Reflect.get(globalThis, Symbol.for("vitehub.console.auth.client")) as ReturnType<typeof createAuthClient> | undefined;
    })
    .catch(() => undefined)
    .then((configured) => configured ?? createAuthClient({ basePath: authBase }));
  return await authClientRequest;
}

async function loadAuthSession(): Promise<void> {
  try {
    const authClient = await consoleAuthClient();
    const { data } = await authClient.getSession();
    signedIn.value = Boolean(data?.session);
  } catch {
    signedIn.value = false;
  }
}

async function signOut(): Promise<void> {
  signingOut.value = true;
  signOutFailed.value = false;
  if (accessIdentity.value) {
    window.location.assign(accessIdentity.value.signOutURL);
    return;
  }
  try {
    const authClient = await consoleAuthClient();
    const { error } = await authClient.signOut();
    if (error) throw error;
    window.location.assign(signInURL);
  } catch {
    signOutFailed.value = true;
    signingOut.value = false;
  }
}

onMounted(() => {
  unsubscribe = subscribeConsoleNavigation(props.sectionsBase, (value) => {
    navigation.value = value;
  });
  void loadNavigation();
});
onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <nav class="vitehub-console__rail" aria-label="Console">
    <UTooltip :text="`${projectName} overview`" :content="{ side: 'right' }">
      <button
        type="button"
        class="vitehub-console__rail-item vitehub-console__rail-home"
        :aria-current="active ? undefined : 'page'"
        :aria-label="`${projectName} overview`"
        @click="open('vitehub-console')"
      >
        <ConsoleMark class="size-[1.125rem]" />
      </button>
    </UTooltip>

    <div class="vitehub-console__rail-sections">
      <template v-if="!navigation && !navigationFailed">
        <USkeleton v-for="index in 5" :key="index" class="size-8 rounded-md" />
      </template>
      <UTooltip v-if="navigationFailed && !navigation" text="Retry loading primitives" :content="{ side: 'right' }">
        <button
          type="button"
          class="vitehub-console__rail-item"
          aria-label="Retry loading primitives"
          @click="loadNavigation"
        >
          <UIcon name="i-ph-arrows-clockwise-light" class="size-[1.125rem]" />
        </button>
      </UTooltip>
      <div v-for="(group, index) in groups" :key="index" class="vitehub-console__rail-group">
        <UTooltip v-for="section in group" :key="section.id" :text="section.label" :content="{ side: 'right' }">
          <button
            type="button"
            class="vitehub-console__rail-item"
            :aria-current="section.id === active ? 'page' : undefined"
            :aria-label="section.label"
            @click="open(section.routeName)"
          >
            <UIcon :name="section.icon" class="size-[1.125rem]" />
          </button>
        </UTooltip>
      </div>
    </div>

    <div class="vitehub-console__rail-footer">
      <UDashboardSearchButton
        class="vitehub-console__rail-item vitehub-console__rail-search"
        collapsed
        :tooltip="{ content: { side: 'right' } }"
        label="Search"
      />
      <UDropdownMenu
        v-if="appearance"
        :items="appearanceItems"
        :content="{ side: 'right', align: 'end', sideOffset: 8 }"
        :ui="{ content: 'min-w-40' }"
      >
        <UTooltip :text="appearanceLabel" :content="{ side: 'right' }">
          <button type="button" class="vitehub-console__rail-item" :aria-label="appearanceLabel">
            <UIcon :name="currentAppearance.icon" class="size-4" />
          </button>
        </UTooltip>
      </UDropdownMenu>
      <UTooltip v-if="signedIn" :text="signOutFailed ? 'Could not sign out. Try again.' : signOutLabel" :content="{ side: 'right' }">
        <button
          type="button"
          class="vitehub-console__rail-item"
          :aria-label="signOutFailed ? 'Retry sign out' : signOutLabel"
          :disabled="signingOut"
          @click="signOut"
        >
          <UIcon :name="signingOut ? 'i-lucide-loader-circle' : 'i-lucide-log-out'" class="size-4" :class="signingOut ? 'animate-spin' : ''" />
        </button>
      </UTooltip>
    </div>
  </nav>
</template>

<style>
.vitehub-console__rail {
  align-items: center;
  background: var(--ui-bg-muted);
  border-inline-end: 1px solid var(--ui-border);
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.25rem;
  height: 100%;
  padding-block: 0.5rem;
  width: 3rem;
}

.dark .vitehub-console__rail {
  background: #000;
  border-inline-end-color: rgb(255 255 255 / 8%);
}

.vitehub-console__rail-sections {
  align-items: center;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
  width: 100%;
}

/* Groups separate with a short hairline, like the product rail in Supabase. */
.vitehub-console__rail-group {
  align-items: center;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding-block: 0.375rem;
  position: relative;
  width: 100%;
}

.vitehub-console__rail-group + .vitehub-console__rail-group::before {
  background: var(--ui-border);
  content: "";
  height: 1px;
  inset-block-start: 0;
  inset-inline-start: 50%;
  position: absolute;
  transform: translateX(-50%);
  width: 1.25rem;
}

.vitehub-console__rail-footer {
  align-items: center;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.vitehub-console .vitehub-console__rail-item {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  display: inline-flex;
  height: 2rem;
  justify-content: center;
  position: relative;
  transition:
    background-color 150ms ease,
    color 150ms ease;
  width: 2rem;
}

.vitehub-console .vitehub-console__rail-item:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

.vitehub-console .vitehub-console__rail-item:focus-visible {
  outline: 2px solid var(--ui-border-inverted);
  outline-offset: 1px;
}

.vitehub-console .vitehub-console__rail-item[aria-current="page"] {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

/* The active section also shows a short bar on the rail edge. */
.vitehub-console .vitehub-console__rail-item[aria-current="page"]::before {
  background: var(--ui-text-highlighted);
  border-radius: 0 2px 2px 0;
  content: "";
  height: 1rem;
  inset-block-start: 50%;
  inset-inline-start: -0.5rem;
  position: absolute;
  transform: translateY(-50%);
  width: 2px;
}

.vitehub-console .vitehub-console__rail-home {
  color: var(--ui-text-highlighted);
  margin-block-end: 0.25rem;
}

.vitehub-console .vitehub-console__rail-home[aria-current="page"]::before {
  display: none;
}

.vitehub-console .vitehub-console__rail-search {
  box-shadow: none !important;
  padding: 0 !important;
}

.vitehub-console .vitehub-console__rail-search:not(:hover) {
  background: transparent !important;
}
</style>
