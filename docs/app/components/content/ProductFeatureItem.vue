<script setup lang="ts">
// One feature of a product landing page: a claim and one line of 12 words or fewer. The card is
// the link to the page that explains the feature. Lives inside `::product-features`.
defineProps<{
  title: string;
  /** Icon shown above the title. */
  icon?: string;
  /** Docs page that explains the feature in full. */
  to: string;
}>();
</script>

<template>
  <NuxtLink :to="to" class="vh-feature-item group">
    <UIcon v-if="icon" :name="icon" class="size-4 shrink-0 text-muted transition-colors group-hover:text-highlighted" />
    <h3 class="vh-feature-item-title">
      <span>{{ title }}</span>
      <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-3.5 shrink-0 text-muted transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
    </h3>
    <div class="vh-feature-item-body">
      <slot />
    </div>
  </NuxtLink>
</template>

<style scoped>
.vh-feature-item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  padding: 1.125rem 1.25rem;
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
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0.25rem 0 0;
  color: var(--ui-text-highlighted);
  font-size: 0.9375rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.375rem;
}

.vh-feature-item-body,
.vh-feature-item-body :deep(p) {
  margin: 0;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  line-height: 1.25rem;
  text-wrap: pretty;
}

.vh-feature-item-body :deep(code) {
  font-size: 0.75rem;
}

@media (prefers-reduced-motion: reduce) {
  .vh-feature-item {
    transition: none;
  }
}
</style>
