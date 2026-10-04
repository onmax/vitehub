<script setup lang="ts">
// `::product-feature` is one feature section of a product landing page: a title, the default slot
// as prose on one side, and the `#code` slot (a code fence or a component) on the other side.
defineProps<{
  title: string;
  /** Short label above the title, for example "Capabilities". */
  label?: string;
  /** Docs page that explains the feature in full. */
  to?: string;
  /** Link text. Defaults to "Read more". */
  linkLabel?: string;
  /** Put the code on the left and the copy on the right. */
  reverse?: boolean;
}>();
</script>

<template>
  <section class="vh-feature" :class="{ 'is-reverse': reverse }">
    <div class="vh-feature-copy">
      <p v-if="label" class="not-prose vh-feature-label">{{ label }}</p>
      <h2 class="not-prose vh-feature-title">{{ title }}</h2>
      <div class="vh-feature-body">
        <slot />
      </div>
      <NuxtLink v-if="to" :to="to" class="not-prose vh-feature-link group">
        {{ linkLabel || "Read more" }}
        <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
      </NuxtLink>
    </div>

    <div v-if="$slots.code" class="vh-feature-panel">
      <slot name="code" />
    </div>
  </section>
</template>

<style scoped>
.vh-feature {
  display: grid;
  gap: 1.5rem;
  padding: 3.5rem 0;
  border-bottom: 1px solid var(--ui-border);
}

@media (min-width: 64rem) {
  .vh-feature {
    grid-template-columns: minmax(18rem, 0.8fr) minmax(0, 1.2fr);
    align-items: center;
    gap: 4rem;
    padding: 4.5rem 0;
  }

  .vh-feature.is-reverse .vh-feature-copy {
    order: 2;
  }
}

.vh-feature-label {
  margin: 0 0 0.75rem;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.vh-feature-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: clamp(1.625rem, 2.4vw, 2.125rem);
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.15;
  text-wrap: balance;
}

.vh-feature-body {
  margin-top: 1rem;
  color: var(--ui-text-muted);
  font-size: 1rem;
  line-height: 1.75rem;
}

.vh-feature-body :deep(> :first-child) {
  margin-top: 0;
}

.vh-feature-body :deep(> :last-child) {
  margin-bottom: 0;
}

.vh-feature-body :deep(p),
.vh-feature-body :deep(li) {
  color: var(--ui-text-muted);
  font-size: 1rem;
}

.vh-feature-link {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  gap: 0.375rem;
  margin-top: 1rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
}

.vh-feature-link:hover .landing-cta-arrow {
  transform: translateX(0.25rem);
}

.vh-feature-panel {
  min-width: 0;
}

.vh-feature-panel :deep(> *) {
  margin: 0;
}

.vh-feature-panel :deep(> * + *) {
  margin-top: 1rem;
}

.vh-feature-panel :deep(pre) {
  font-size: 0.8125rem;
  line-height: 1.75;
}
</style>
