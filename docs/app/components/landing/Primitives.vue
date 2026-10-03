<script setup lang="ts">
import { useIntersectionObserver } from "@vueuse/core";
import { landingPrimitives } from "./content";

const grid = useTemplateRef<HTMLElement>("grid");
const visible = ref(false);
const replay = ref(0);

// Loops run only while the grid is on screen.
useIntersectionObserver(
  grid,
  ([entry]) => {
    visible.value = entry?.isIntersecting ?? false;
  },
  { threshold: 0.1 },
);

// Spread start points across the loop so neighboring tiles do not move together.
function offset(index: number) {
  return (index * 0.37) % 1;
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
          One server API, Agents included.
        </h2>
        <div class="max-w-[40ch] lg:justify-self-end">
          <p class="text-base/7 text-muted">
            The Agent is one primitive among the others. Call any primitive from a route, a job, or
            an Agent. Each one works without the others.
          </p>
          <NuxtLink
            to="/docs/server-primitives"
            class="group mt-3 mr-5 inline-flex min-h-10 items-center gap-2 text-sm font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            Explore Server Primitives
            <UIcon
              name="i-lucide-arrow-right"
              class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </NuxtLink>
          <button
            type="button"
            class="mt-3 inline-flex min-h-10 items-center text-sm font-medium text-highlighted underline decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
            @click="replay += 1"
          >
            Replay scenes
          </button>
        </div>
      </div>

      <ul
        ref="grid"
        class="mt-10 grid grid-cols-2 gap-px border border-default bg-[var(--ui-border)] sm:grid-cols-4 lg:mt-12 lg:grid-cols-5"
        role="list"
      >
        <!-- The Agent tile spans two cells, so 20 cells fill every row at 2, 4, and 5 columns. -->
        <li
          v-for="(primitive, index) in landingPrimitives"
          :key="`${primitive.id}-${replay}`"
          class="min-w-0 bg-default"
          :class="{ 'col-span-2': primitive.id === 'agent' }"
        >
          <NuxtLink
            :to="primitive.to"
            class="primitive-tile group flex h-full flex-col gap-3 p-4 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
          >
            <div
              class="h-10 w-full text-muted transition-colors duration-200 group-hover:text-highlighted"
            >
              <LandingPrimitiveMotion :name="primitive.id" :play="visible" :offset="offset(index)" />
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
/* Scenes with overlapping shapes fill them with the tile background. */
.primitive-tile {
  --tile-bg: var(--ui-bg);
  background: var(--tile-bg);
  transition: background-color 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
  .primitive-tile:hover {
    --tile-bg: color-mix(in srgb, var(--ui-bg-muted) 35%, var(--ui-bg));
  }

  .group:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .primitive-tile {
    transition: none;
  }
}
</style>
