<script setup lang="ts">
// One feature of a product landing page: a claim, one sentence in the default slot, and a link
// whose label names the page it opens. Lives inside `::product-features`.
defineProps<{
  title: string;
  /** Icon shown above the title. */
  icon?: string;
  /** Docs page that explains the feature in full. */
  to: string;
  /** Link text. Name the destination, for example "KV server API". */
  linkLabel: string;
}>();
</script>

<template>
  <NuxtLink :to="to" class="vh-feature-item group">
    <UIcon v-if="icon" :name="icon" class="size-4 shrink-0 text-muted transition-colors group-hover:text-highlighted" />
    <h3 class="vh-feature-item-title">{{ title }}</h3>
    <div class="vh-feature-item-body">
      <slot />
    </div>
    <span class="vh-feature-item-link">
      {{ linkLabel }}
      <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
    </span>
  </NuxtLink>
</template>

<style scoped>
.vh-feature-item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  padding: 1.25rem;
  transition: background-color 200ms ease;
}

.vh-feature-item:hover {
  background: color-mix(in srgb, var(--ui-bg-muted) 35%, var(--ui-bg));
}

.vh-feature-item:hover .landing-cta-arrow {
  transform: translateX(0.25rem);
}

.vh-feature-item:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.vh-feature-item-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.5rem;
  text-wrap: balance;
}

.vh-feature-item-body,
.vh-feature-item-body :deep(p) {
  margin: 0;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.375rem;
  text-wrap: pretty;
}

.vh-feature-item-body :deep(code) {
  font-size: 0.8125rem;
}

.vh-feature-item-link {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-top: auto;
  padding-top: 0.5rem;
  color: var(--ui-text-highlighted);
  font-size: 0.8125rem;
  font-weight: 500;
}

@media (prefers-reduced-motion: reduce) {
  .vh-feature-item {
    transition: none;
  }
}
</style>
