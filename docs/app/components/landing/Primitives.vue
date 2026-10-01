<script setup lang="ts">
import { useIntersectionObserver } from "@vueuse/core";
import { landingPrimitives } from "./content";

const grid = useTemplateRef<HTMLElement>("grid");
const visible = ref(false);
const replays = reactive<Record<string, number>>({});

useIntersectionObserver(
  grid,
  ([entry]) => {
    if (entry?.isIntersecting) {
      visible.value = true;
    }
  },
  { threshold: 0.35 },
);

// Remounting a scene restarts its single pass without a timer.
function replay(id: string) {
  if (!visible.value) {
    return;
  }
  replays[id] = (replays[id] ?? 0) + 1;
}
</script>

<template>
  <section class="border-b border-default bg-default">
    <div class="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 sm:py-20 lg:px-12 lg:py-24">
      <div
        class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.6fr)] lg:items-end lg:gap-16"
      >
        <h2
          class="max-w-[16ch] text-3xl/9 font-semibold tracking-[-0.03em] text-highlighted text-balance sm:text-4xl/10"
        >
          Built on Server Primitives.
        </h2>
        <div class="max-w-[40ch] lg:justify-self-end">
          <p class="text-base/7 text-muted">
            Capabilities use the same storage, queue, and sandbox APIs that your routes can call
            without an Agent.
          </p>
          <NuxtLink
            to="/docs/server-primitives"
            class="group mt-3 inline-flex min-h-10 items-center gap-2 text-sm font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Explore Server Primitives
            <UIcon
              name="i-lucide-arrow-right"
              class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </NuxtLink>
        </div>
      </div>

      <ul
        ref="grid"
        class="mt-10 grid grid-cols-2 gap-px border border-default bg-[var(--ui-border)] sm:grid-cols-3 lg:mt-12 lg:grid-cols-6"
        role="list"
      >
        <li v-for="(primitive, index) in landingPrimitives" :key="primitive.id" class="min-w-0 bg-default">
          <NuxtLink
            :to="primitive.to"
            class="group flex h-full flex-col gap-3 p-4 transition-colors duration-200 hover:bg-muted/35 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
            @pointerenter="replay(primitive.id)"
            @focus="replay(primitive.id)"
          >
            <div
              class="h-10 w-full text-muted transition-colors duration-200 group-hover:text-highlighted"
            >
              <LandingPrimitiveMotion
                :key="replays[primitive.id] ?? 0"
                :name="primitive.id"
                :play="visible"
                :delay="replays[primitive.id] ? 0 : index * 70"
              />
            </div>
            <div>
              <h3 class="text-sm font-medium text-highlighted">
                {{ primitive.name }}
              </h3>
              <p class="mt-0.5 text-xs text-muted">
                {{ primitive.description }}
              </p>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
@media (hover: hover) and (pointer: fine) {
  .group:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}
</style>
