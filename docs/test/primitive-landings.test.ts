import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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
    for (const landing of Object.values(primitiveLandings).filter((entry) => entry.slug !== "auth")) {
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
