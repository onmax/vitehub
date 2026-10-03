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
  padding: 3rem 0 0;
}

.vh-features-title {
  margin: 0 0 1.25rem;
  color: var(--ui-text-highlighted);
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

/* Each item draws its right and bottom line, so a short last row leaves no filler cells. */
.vh-features-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  border-top: 1px solid var(--ui-border);
  border-left: 1px solid var(--ui-border);
}

@media (min-width: 40rem) {
  .vh-features-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 64rem) {
  .vh-features-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
