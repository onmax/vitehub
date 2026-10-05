import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DatabasesLanding } from "../app/data/primitive-landings/databases";
import { getPrimitiveLanding, primitiveLandings } from "../app/data/primitive-landings";

describe("primitive landing routes", () => {
  it("resolves registered primitives", () => {
    for (const landing of Object.values(primitiveLandings)) {
      expect(getPrimitiveLanding(landing.slug)).toBe(landing);
    }
  });

  it("leaves unknown and inherited object names to the route fallback", () => {
    for (const slug of ["missing-primitive", "constructor", "toString", "__proto__"]) {
      expect(getPrimitiveLanding(slug)).toBeUndefined();
    }
  });
});

describe("primitive landing placeholders", () => {
  it("marks every stub variant as illustrative and removes invented APIs", () => {
    for (const landing of Object.values(primitiveLandings)) {
      if (landing === DatabasesLanding) continue;
      expect(landing.description).not.toContain("working project");
      for (const variant of landing.variants) {
        expect(variant.illustrative).toBe(true);
        const source = variant.files.map((file) => file.content).join("\n");
        expect(source).toContain("Illustrative pseudocode");
        expect(source).not.toMatch(/definePrimitive|vite-hub\/vite|from ["']vite-hub\//);
      }
    }
  });

  it("displays the placeholder notice above the selected files", async () => {
    const source = await readFile(
      new URL("../app/components/PrimitiveProjectGroup.vue", import.meta.url),
      "utf8",
    );
    expect(source).toContain('v-if="currentVariant?.illustrative"');
    expect(source).toContain("Illustrative pseudocode. This layout is not an executable starter.");
  });
});

describe("database landing examples", () => {
  it.each(DatabasesLanding.variants)("loads the $label schema using the database package", async (variant) => {
    const root = await mkdtemp(new URL("../.database-landing-", import.meta.url));
    try {
      const definition = variant.files.find((file) => /(?:src\/database|server\/databases\/config)\.ts$/.test(file.path));
      expect(definition).toBeDefined();
      const path = join(root, "database.mjs");
      await writeFile(path, definition!.content);
      const { default: database } = await import(/* @vite-ignore */ pathToFileURL(path).href);
      expect(database.name).toBe("default");
      const columns = getTableColumns(database.schema.notes);
      expect(Object.keys(columns)).toEqual(["id", "title"]);
      expect(columns.id.primary).toBe(true);
      expect(columns.title.notNull).toBe(true);
      const config = variant.files.find((file) => file.path.endsWith(".config.ts"));
      expect(config?.content).toContain("database: true");
      expect(variant.files.map((file) => file.content).join("\n")).not.toMatch(/definePrimitive|vite-hub\/databases/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links to the current database guide", async () => {
    expect(DatabasesLanding.docsTo).toBe("/docs/database");
    await expect(readFile(new URL("../content/docs/database/index.md", import.meta.url), "utf8")).resolves.toContain("title: Database");
  });
});
