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
    for (const landing of Object.values(primitiveLandings)) {
      expect(landing.description).not.toContain("working project");
      if (landing.slug === "sandbox") continue;
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

describe("Sandbox landing projects", () => {
  it("supplies package handlers, callers, and configured hosts", () => {
    const landing = getPrimitiveLanding("sandbox")!;
    for (const variant of landing.variants) {
      expect(variant.illustrative).toBe(false);
      const files = new Map(variant.files.map(file => [file.path, file.content]));
      const manifest = JSON.parse(files.get("package.json")!);
      for (const dependency of ["vite-hub", "@vite-hub/sandbox", "@vercel/sandbox", ...(variant.framework === "nuxt" ? ["nuxt"] : ["vite", "nitro"])]) {
        expect(manifest.dependencies[dependency]).toBeTruthy();
      }
      const config = files.get(variant.framework === "nuxt" ? "nuxt.config.ts" : "vite.config.ts");
      expect(config).toContain('preset: "vercel", sandbox: true');
      expect(files.get("server/sandboxes/release-notes/index.ts")).toContain("export default async function");
      expect(files.get("server/sandboxes/release-notes/index.ts")).not.toContain("defineSandbox");
      expect(files.get("server/release-notes.ts")).toContain('runSandbox("release-notes", { notes: "ship it" })');
      expect(JSON.parse(files.get("server/sandboxes/release-notes/package.json")!).type).toBe("module");
    }
  });
});
