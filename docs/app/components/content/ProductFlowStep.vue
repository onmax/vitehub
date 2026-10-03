<script setup lang="ts">
// One node on a `::product-flow` rail: a marker, a short label, and a mono detail such as the call
// or the component that handles this step.
defineProps<{
  label: string;
  /** The call, file, or component at this step, shown in mono. */
  detail?: string;
  /** Marks the step that can repeat, such as a retry or a poll. */
  loop?: boolean;
}>();
</script>

<template>
  <li class="vh-flow-step">
    <span class="vh-flow-marker" :class="{ 'is-loop': loop }" aria-hidden="true" />
    <span class="vh-flow-label">{{ label }}</span>
    <span v-if="detail" class="vh-flow-detail">{{ detail }}</span>
    <span v-if="loop" class="vh-flow-loop">repeats</span>
  </li>
</template>

<style scoped>
.vh-flow-step {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.375rem;
  padding-right: 1.25rem;
}

/* A hollow marker sits on the rail. The loop marker is a ring with a second ring. */
.vh-flow-marker {
  display: block;
  width: 0.6875rem;
  height: 0.6875rem;
  border: 1px solid var(--ui-text-highlighted);
  border-radius: 9999px;
  background: var(--ui-bg);
}

.vh-flow-marker.is-loop {
  box-shadow: 0 0 0 3px var(--ui-bg), 0 0 0 4px var(--ui-border-accented);
}

.vh-flow-label {
  margin-top: 0.5rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
}

.vh-flow-detail {
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.125rem;
  overflow-wrap: anywhere;
}

.vh-flow-loop {
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
}
</style>
