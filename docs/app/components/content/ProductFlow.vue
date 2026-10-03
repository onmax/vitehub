<script setup lang="ts">
// `::product-flow` is the one explanatory diagram of a product landing page: a rail of three to
// five `:::product-flow-step` nodes that show what happens in one call, and one caption line.
// A token travels the rail once when the diagram enters the viewport.
import { useIntersectionObserver, usePreferredReducedMotion } from "@vueuse/core";

defineProps<{
  /** One line under the rail that names the guarantee or the result. */
  caption?: string;
}>();

const flow = useTemplateRef<HTMLElement>("flow");
const reducedMotion = usePreferredReducedMotion();
const played = ref(false);

useIntersectionObserver(
  flow,
  ([entry]) => {
    if (entry?.isIntersecting && reducedMotion.value !== "reduce") played.value = true;
  },
  { threshold: 0.6 },
);

function replay() {
  if (reducedMotion.value === "reduce") return;
  played.value = false;
  requestAnimationFrame(() => { played.value = true; });
}
</script>

<template>
  <figure ref="flow" class="not-prose vh-flow" :class="{ 'is-played': played }" @click="replay">
    <div class="vh-flow-rail" aria-hidden="true">
      <span class="vh-flow-token" />
    </div>
    <ol class="vh-flow-steps">
      <slot />
    </ol>
    <figcaption v-if="caption" class="vh-flow-caption">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.vh-flow {
  position: relative;
  margin: 0;
  padding: 2rem 0 0;
  cursor: default;
}

.vh-flow-steps {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1.5rem 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* The rail runs behind the node markers. On narrow screens the steps wrap and the rail is hidden. */
.vh-flow-rail {
  position: absolute;
  top: calc(2.5rem + 0.3125rem);
  right: 0;
  left: 0;
  display: none;
  height: 1px;
  background: var(--ui-border);
}

@media (min-width: 48rem) {
  .vh-flow-rail {
    display: block;
  }

  .vh-flow-steps {
    display: flex;
  }

  .vh-flow-steps > :deep(li) {
    flex: 1 1 0;
  }
}

.vh-flow-token {
  position: absolute;
  top: -0.1875rem;
  left: 0;
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 9999px;
  background: var(--ui-text-highlighted);
  opacity: 0;
}

.vh-flow.is-played .vh-flow-token {
  animation: vh-flow-travel 2200ms cubic-bezier(0.22, 1, 0.36, 1) 200ms both;
}

@keyframes vh-flow-travel {
  0% {
    left: 0;
    opacity: 0;
  }

  8% {
    opacity: 1;
  }

  92% {
    opacity: 1;
  }

  100% {
    left: calc(100% - 0.4375rem);
    opacity: 0;
  }
}

.vh-flow-caption {
  margin: 1.5rem 0 0;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

@media (prefers-reduced-motion: reduce) {
  .vh-flow.is-played .vh-flow-token {
    animation: none;
  }
}
</style>
