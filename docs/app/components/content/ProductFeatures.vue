<script setup lang="ts">
// `::product-features` is the feature list of a product landing page. Its default slot holds
// `:::product-feature-item` entries: one claim, one sentence, one link. No code: the hero carries the code.
defineProps<{
  /** Optional heading above the list. */
  title?: string;
}>();
</script>

<template>
  <section class="not-prose vh-features">
    <h2 v-if="title" class="vh-features-title">{{ title }}</h2>
    <div class="vh-features-grid">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.vh-features {
  padding: 2.5rem 0 0;
}

.vh-features-title {
  margin: 0 0 1.25rem;
  color: var(--ui-text-highlighted);
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.vh-features-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1px;
  border: 1px solid var(--ui-border);
  background: var(--ui-border);
}

@media (min-width: 40rem) {
  .vh-features-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 64rem) {
  .vh-features-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    grid-auto-rows: minmax(9rem, auto);
  }
}
</style>
