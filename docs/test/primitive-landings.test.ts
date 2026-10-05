import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ContentLanding } from "../app/data/primitive-landings/content";
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
    for (const landing of Object.values(primitiveLandings).filter((landing) => landing.slug !== "content")) {
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

describe("Content landing examples", () => {
  it("provides a discoverable Content definition and a document for every host", () => {
    expect(ContentLanding.variants.map((variant) => variant.framework)).toEqual(["vite", "nitro", "nuxt"]);
    for (const variant of ContentLanding.variants) {
      const definition = variant.files.find((file) => file.path === "server/content.ts");
      expect(definition?.content).toContain('import { defineContent } from "vite-hub/content"');
      expect(definition?.content).toContain("export const content = defineContent(");
      expect(definition?.content).toContain('glob({ cwd: "docs", include: "**/*.md" })');
      expect(variant.files.some((file) => file.path === "docs/guide.md")).toBe(true);
      const manifest = JSON.parse(variant.files.find((file) => file.path === "package.json")!.content);
      expect(manifest.dependencies["vite-hub"]).toBeTruthy();
      expect(manifest.dependencies["comark-content"]).toBeTruthy();
      expect(variant.files.map((file) => file.content).join("\n")).not.toMatch(/definePrimitive|vite-hub\/vite|Illustrative pseudocode/);
    }
  });

  it("mounts the handler explicitly only in the standalone Nitro example", () => {
    for (const variant of ContentLanding.variants) {
      const route = variant.files.find((file) => file.path.startsWith("server/routes/"));
      if (variant.framework === "nitro") {
        expect(route?.path).toBe("server/routes/api/content/[...path].ts");
        expect(route?.content).toContain('import { content } from "../../../content"');
        expect(route?.content).toContain("export default defineContentHandler(content)");
      } else {
        expect(route).toBeUndefined();
        expect(variant.files.find((file) => file.path.endsWith(".config.ts"))?.content).toContain('preset: "node"');
      }
    }
  });
});
