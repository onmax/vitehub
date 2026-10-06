import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getPrimitiveLanding, primitiveLandings } from "../app/data/primitive-landings";
import { stubLanding } from "../app/data/primitive-landings/stub";

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
    const landing = stubLanding("example", "Example", "/docs/example");
    expect(landing.description).not.toContain("working project");
    for (const variant of landing.variants) {
      expect(variant.illustrative).toBe(true);
      const source = variant.files.map((file) => file.content).join("\n");
      expect(source).toContain("Illustrative pseudocode");
      expect(source).not.toMatch(/definePrimitive|vite-hub\/vite|from ["']vite-hub\//);
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

describe("Browser landing examples", () => {
  it("configures supported hosts and uses the discovered Browser API", () => {
    const browser = getPrimitiveLanding("browser")!;
    expect(browser.docsTo).toBe("/docs/browser");
    expect(browser.supported).toContain("Cloudflare Browser Run");
    expect(browser.variants.map(variant => variant.framework)).toEqual(["vite", "nuxt"]);
    for (const variant of browser.variants) {
      expect(variant.illustrative).not.toBe(true);
      const source = variant.files.map(file => file.content).join("\n");
      expect(source).toContain('preset: "cloudflare", browser: true');
      expect(source).not.toMatch(/definePrimitive|vite-hub\/vite/);
      expect(variant.files.find(file => file.path === "server/browsers/page-html.ts")?.content).toContain("defineBrowser");
      expect(source).toContain('runBrowser("page-html",');
    }
  });
});
