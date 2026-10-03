<template>
  <UDashboardGroup class="vitehub-console" unit="rem" storage-key="vitehub-console-v2">
    <slot />
  </UDashboardGroup>
</template>

<style>
.vitehub-console {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.vitehub-console__nav[data-slot="root"] {
  background: var(--ui-bg-muted);
  border-inline-end: 1px solid var(--ui-border);
}

.dark .vitehub-console__nav[data-slot="root"] {
  background: #000;
  border-inline-end-color: rgb(255 255 255 / 8%);
}

.vitehub-console__nav [data-slot="header"] {
  min-height: 2.75rem;
  padding-inline: 0.5rem;
}

/* The search entry is a ghost row in every sidebar, like T3 Code's search row. */
.vitehub-console__search {
  justify-content: flex-start !important;
  border: 0 !important;
  box-shadow: none !important;
  color: var(--ui-text-muted) !important;
  font-size: 0.8125rem !important;
  font-weight: 500 !important;
  height: 2rem !important;
  min-height: 2rem !important;
  padding-inline: 0.5rem !important;
}

.vitehub-console__search:hover {
  color: var(--ui-text) !important;
}

.vitehub-console__search [data-slot="trailing"] {
  display: none;
}

.vitehub-console__nav-item[aria-current="page"] {
  color: var(--ui-text-highlighted);
}
</style>
