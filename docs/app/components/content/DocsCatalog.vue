<script setup lang="ts">
import { docsManifest } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { docsRootSectionId, getDocsCatalog } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

type CatalogCard = {
  description: string | null;
  icon: string;
  key: string;
  title: string;
  to: string;
};

type CatalogRow = {
  cards: CatalogCard[];
  category: string;
};

const rows = computed<CatalogRow[]>(() =>
  getDocsCatalog(docsManifest.sections).map((group) => {
    const startSection = group.category === "Start"
      ? group.sections.find(section => section.id === docsRootSectionId)
      : null;

    // The Start row lists the pages of the Start section. Every other row lists one card per product.
    const cards: CatalogCard[] = startSection
      ? startSection.pages
          .filter(page => page.navigation !== false)
          .map(page => ({
            description: page.description,
            icon: sidebarPageIcon(page),
            key: page.path,
            title: page.sourceTitle || page.title,
            to: page.path,
          }))
      : group.sections.map(section => ({
          description: section.description,
          icon: sidebarSectionIcon(section),
          key: section.id,
          title: section.title,
          to: section.path,
        }));

    return { cards, category: group.category };
  }),
);
</script>

<template>
  <div class="not-prose vh-docs-catalog">
    <section v-for="row in rows" :key="row.category" class="vh-docs-catalog-row">
      <h2 class="vh-docs-catalog-heading">{{ row.category }}</h2>
      <UPageGrid class="vh-docs-catalog-grid">
        <UPageCard
          v-for="card in row.cards"
          :key="card.key"
          :title="card.title"
          :description="card.description || undefined"
          :icon="card.icon"
          :to="card.to"
          variant="outline"
          :ui="{
            root: 'rounded-md',
            container: 'gap-2 p-4 sm:p-4',
            leadingIcon: 'size-5 text-muted',
            title: 'text-sm font-semibold',
            description: 'text-xs leading-5 text-muted',
          }"
        />
      </UPageGrid>
    </section>
  </div>
</template>

<style scoped>
.vh-docs-catalog {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  margin-top: 2rem;
}

.vh-docs-catalog-heading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0 0 0.75rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.vh-docs-catalog-heading::after {
  content: "";
  flex: 1;
  border-bottom: 1px solid var(--ui-border);
}

.vh-docs-catalog-grid {
  gap: 0.75rem;
}
</style>
