import { describe, expect, it } from "vitest";
import { docsManifest, getDocsPageByPath } from "../modules/vitehub-docs/runtime/utils/docs";
import {
  docsCategoryOrder,
  docsRootSectionId,
  getDocsCatalog,
  getDocsSectionForPath,
  getDocsSectionSelectItems,
  getDocsSidebarGroups,
  getUncategorizedDocsSections,
} from "../modules/vitehub-docs/runtime/utils/docs-navigation";
import { createDocsRedirectRouteRules, docsPageRedirects } from "../modules/vitehub-docs/redirects";

const serverPrimitiveSections = [
  "auth",
  "blob",
  "browser",
  "channels",
  "connections",
  "content",
  "database",
  "email",
  "env",
  "kv",
  "queue",
  "rate-limit",
  "realtime",
  "sandbox",
  "schedule",
  "shell",
  "source",
  "workflows",
  "workspace",
];

describe("docs product navigation", () => {
  it("files every section under one catalog category", () => {
    expect(getUncategorizedDocsSections(docsManifest.sections)).toEqual([]);

    const catalog = getDocsCatalog(docsManifest.sections);
    expect(catalog.map(group => group.category)).toEqual([...docsCategoryOrder]);
    expect(catalog.find(group => group.category === "Start")?.sections.map(section => section.id)).toEqual([docsRootSectionId]);

    const productIds = catalog
      .filter(group => ["Data", "Compute", "Access", "Delivery", "Files"].includes(group.category))
      .flatMap(group => group.sections.map(section => section.id))
      .sort();
    expect(productIds).toEqual(serverPrimitiveSections);
    expect(catalog.find(group => group.category === "Agents")?.sections.map(section => section.id)).toEqual(["agents", "ui"]);
  });

  it("gives every Server Primitive an Overview page first and its Agent capability second", () => {
    for (const sectionId of serverPrimitiveSections) {
      const section = docsManifest.sections.find(candidate => candidate.id === sectionId);
      const pages = section?.pages.filter(page => page.navigation) || [];

      expect(pages[0]?.path, sectionId).toBe(`/docs/${sectionId}`);
      expect(pages[0]?.title, sectionId).toBe("Overview");

      const capability = pages.find(page => page.id === "agent-capability");
      if (capability) {
        expect(pages[1]?.path, sectionId).toBe(`/docs/${sectionId}/agent-capability`);
        expect(capability.title, sectionId).toBe("Agent capability");
        expect(capability.sourceTitle, sectionId).toBe(`${section?.title} capability`);
      }
    }
  });

  it("keeps Agent-only Capabilities inside the Agents section", () => {
    const agents = docsManifest.sections.find(section => section.id === "agents");
    const capabilities = agents?.pages.filter(page => page.id.startsWith("capabilities")) || [];

    expect(capabilities.map(page => page.path)).toContain("/docs/agents/capabilities");
    expect(capabilities.map(page => page.path)).toContain("/docs/agents/capabilities/mcp");
    expect(capabilities.every(page => page.group === "Capabilities")).toBe(true);
    expect(docsManifest.sections.map(section => section.id)).not.toContain("capabilities");
    expect(docsManifest.sections.map(section => section.id)).not.toContain("server-primitives");
  });

  it("resolves the sidebar section from the route", () => {
    expect(getDocsSectionForPath(docsManifest.sections, "/docs/kv/agent-capability/")?.id).toBe("kv");
    expect(getDocsSectionForPath(docsManifest.sections, "/docs/agents/capabilities/mcp")?.id).toBe("agents");
    expect(getDocsSectionForPath(docsManifest.sections, "/docs")?.id).toBe(docsRootSectionId);
    expect(getDocsSectionForPath(docsManifest.sections, "/docs/unknown")?.id).toBe(docsRootSectionId);
  });

  it("lists each product once in the select, grouped by category", () => {
    const groups = getDocsSectionSelectItems(docsManifest.sections);

    expect(groups.map(group => group[0]?.label)).toEqual([...docsCategoryOrder]);
    expect(groups.every(group => group[0]?.type === "label")).toBe(true);

    const values = groups.flat().filter(item => item.value).map(item => item.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toHaveLength(docsManifest.sections.length);
    expect(groups.flat().find(item => item.value === "kv")).toMatchObject({ label: "KV", to: "/docs/kv" });
  });

  it("groups every navigable page of a large section", () => {
    for (const sectionId of ["agents", "concepts", "development", "frameworks-hosts", "reference", "ui"]) {
      const section = docsManifest.sections.find(candidate => candidate.id === sectionId);
      const groups = getDocsSidebarGroups(section!);

      expect(groups.length, sectionId).toBeGreaterThan(0);
      expect(groups.every(group => group.label && group.pages.length > 0), sectionId).toBe(true);
    }

    const kv = docsManifest.sections.find(candidate => candidate.id === "kv");
    expect(getDocsSidebarGroups(kv!).map(group => group.label)).toEqual([null]);
  });

  it("lists each topic once inside a section", () => {
    for (const section of docsManifest.sections) {
      // UI components are named after the feature they render.
      if (section.id === "ui") continue;
      const pathsByTitle = new Map<string, string[]>();

      for (const page of section.pages.filter(page => page.navigation && page.title !== "Overview")) {
        const title = page.title.toLowerCase();
        pathsByTitle.set(title, [...(pathsByTitle.get(title) || []), page.path]);
      }

      const duplicates = [...pathsByTitle].filter(([, paths]) => paths.length > 1);
      expect(duplicates, section.id).toEqual([]);
    }
  });

  it("keeps commas in frontmatter titles", () => {
    expect(getDocsPageByPath("/docs/concepts/runtime-policy-approvals-and-traces")?.title)
      .toBe("Runtime policy, approvals, and traces");
  });

  it("redirects each removed page, its trailing-slash form, and its raw Markdown copy to a published page", () => {
    const routeRules = createDocsRedirectRouteRules();

    expect(docsPageRedirects["/docs/server-primitives/kv"]).toBe("/docs/kv");
    expect(docsPageRedirects["/docs/capabilities/db"]).toBe("/docs/database/agent-capability");
    expect(docsPageRedirects["/docs/capabilities/mcp"]).toBe("/docs/agents/capabilities/mcp");

    for (const [from, to] of Object.entries(docsPageRedirects)) {
      expect(getDocsPageByPath(from), from).toBeNull();
      expect(getDocsPageByPath(to), to).not.toBeNull();
      expect(routeRules[from]).toEqual({ redirect: { statusCode: 301, to } });
      expect(routeRules[`${from}/`]).toEqual({ redirect: { statusCode: 301, to } });
      expect(routeRules[`/raw${from}.md`]).toEqual({ redirect: { statusCode: 301, to: `/raw${to}.md` } });
    }
  });
});
