<script setup lang="ts">
/**
 * One scroll-driven tutorial section. The default slot is the readable, mobile-first
 * copy. CodeTreeIntersection registers its fenced blocks with the desktop code tree
 * without rendering them a second time on narrow screens.
 */
defineProps<{
  id?: string;
  title?: string;
}>();
</script>

<template>
  <section :id="id" class="vh-tutorial-step">
    <div class="vh-tutorial-step-copy">
      <p v-if="title" class="vh-tutorial-step-label">{{ title }}</p>
      <slot />
    </div>

    <CodeTreeIntersection register-only>
      <slot />
    </CodeTreeIntersection>
  </section>
</template>

<style scoped>
.vh-tutorial-step {
  border-top: 1px solid var(--ui-border);
  padding: 3.5rem 0;
}

.vh-tutorial-step:first-child {
  border-top: 0;
  padding-top: 1rem;
}

.vh-tutorial-step-copy {
  max-width: 48rem;
}

.vh-tutorial-step-label {
  margin: 0 0 1rem;
  color: var(--ui-text-dimmed);
  font: 600 0.6875rem/1.2 var(--font-mono, ui-monospace);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

@media (min-width: 64rem) {
  .vh-tutorial-step {
    min-height: 30rem;
  }

  /* Desktop code lives in the sticky ProseCodeTree. Keep prose focused on the explanation. */
  .vh-tutorial-step-copy :deep(.code-block-wrapper),
  .vh-tutorial-step-copy :deep(pre:has(code)) {
    display: none;
  }
}

@media (max-width: 63.99rem) {
  .vh-tutorial-step-copy :deep(.code-block-wrapper) {
    margin-top: 1.5rem;
  }
}
</style>
