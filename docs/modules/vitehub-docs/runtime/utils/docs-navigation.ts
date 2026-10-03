import { normalizeDocsPath, type DocsPage, type DocsSection } from "./docs";

/** Catalog rows on `/docs` and groups in the product select, in display order. */
export const docsCategoryOrder = [
  "Start",
  "Data",
  "Compute",
  "Access",
  "Delivery",
  "Files",
  "Agents",
  "Platform",
] as const;

export type DocsCategory = (typeof docsCategoryOrder)[number];

export type DocsCatalogGroup = {
  category: DocsCategory;
  sections: DocsSection[];
};

/** The section that owns the sidebar on `/docs` and on pages outside every section. */
export const docsRootSectionId = "getting-started";

function isDocsCategory(value: string | null): value is DocsCategory {
  return value !== null && docsCategoryOrder.some(category => category === value);
}

/** Groups sections by their `.navigation.yml` category. Sections without a known category are skipped. */
export function getDocsCatalog(sections: DocsSection[]): DocsCatalogGroup[] {
  return docsCategoryOrder
    .map(category => ({
      category,
      sections: sections
        .filter(section => section.category === category)
        .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title)),
    }))
    .filter(group => group.sections.length > 0);
}

export function getUncategorizedDocsSections(sections: DocsSection[]) {
  return sections.filter(section => !isDocsCategory(section.category));
}

export function getDocsSectionForPath(sections: DocsSection[], path: string) {
  const normalizedPath = normalizeDocsPath(path);
  const owner = sections.find(section =>
    normalizedPath === normalizeDocsPath(section.path) || normalizedPath.startsWith(`${normalizeDocsPath(section.path)}/`),
  );

  return owner || sections.find(section => section.id === docsRootSectionId) || null;
}

export type DocsSidebarGroup = {
  label: string | null;
  pages: DocsPage[];
};

/** Sidebar rows for one section: navigable pages in order, grouped by `navigation.group`. */
export function getDocsSidebarGroups(section: DocsSection): DocsSidebarGroup[] {
  const groups = new Map<string | null, DocsPage[]>();

  for (const page of section.pages) {
    if (page.navigation === false) continue;
    const label = page.group?.trim() || null;
    groups.set(label, [...(groups.get(label) || []), page]);
  }

  return [...groups].map(([label, pages]) => ({ label, pages }));
}

export type DocsSectionSelectItem = {
  type?: "label";
  label: string;
  value?: string;
  icon?: string | null;
  to?: string;
};

/** Grouped items for the product select: one label row per category, then its sections. */
export function getDocsSectionSelectItems(sections: DocsSection[]): DocsSectionSelectItem[][] {
  return getDocsCatalog(sections).map(group => [
    { type: "label", label: group.category },
    ...group.sections.map(section => ({
      label: section.title,
      value: section.id,
      icon: section.icon,
      to: section.path,
    })),
  ]);
}
