import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverQueueDefinitions } from "../../packages/queue/src/discovery";
import { QueueLanding } from "../app/data/primitive-landings/queue";
import { describe, expect, it } from "vitest";
import { getPrimitiveLanding, primitiveLandings } from "../app/data/primitive-landings";
import { stubLanding } from "../app/data/primitive-landings/stub";

describe("primitive landing routes", () => {
  it("offers only supported Connections hosts in badges and project tabs", () => {
    const landing = getPrimitiveLanding("connections");
    expect(landing?.supported).toEqual(["Vite", "Nitro"]);
    expect(landing?.variants.map((variant) => variant.framework)).toEqual(["vite", "nitro"]);
  });

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

  it("keeps every Auth variant executable and host-enabled", () => {
    const auth = primitiveLandings.auth;
    expect(auth.variants.map((variant) => variant.framework)).toEqual(["vite", "nitro", "nuxt"]);

    for (const variant of auth.variants) {
      expect(variant.illustrative).not.toBe(true);
      const definition = variant.files.find((file) => file.path === "server/auth.ts");
      expect(definition?.content).toContain('import { defineAuth } from "vite-hub/auth"');
      expect(definition?.content).toContain("export default defineAuth(");

      const config = variant.files.find((file) =>
        variant.framework === "nuxt" ? file.path === "nuxt.config.ts" : file.path === "vite.config.ts",
      );
      expect(config).toBeDefined();
      if (variant.framework === "nuxt") {
        expect(config?.content).toContain('import viteHubNuxt from "vite-hub/nuxt"');
        expect(config?.content).toMatch(/modules:\s*\[\[viteHubNuxt,\s*\{[^}]*auth:\s*true/);
      } else {
        expect(config?.content).toContain('import { vitehub } from "vite-hub"');
        expect(config?.content).toMatch(/plugins:\s*\[\s*vitehub\(\{[^}]*auth:\s*true/);
        if (variant.framework === "nitro") {
          expect(config?.content).toContain('import { nitro } from "nitro/vite"');
          expect(config?.content).toContain("nitro()");
        }
      }
      const source = variant.files.map((file) => file.content).join("\n");
      expect(source).not.toMatch(/definePrimitive|vite-hub\/vite|Illustrative pseudocode/);
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

describe("Queue starter projects", () => {
  it.each(QueueLanding.variants)("discovers the documented Queue name for $label", async (variant) => {
    const root = await mkdtemp(join(tmpdir(), "queue-landing-"));
    try {
      for (const file of variant.files) {
        const path = join(root, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
      }
      const definitions = discoverQueueDefinitions({ rootDir: root });
      expect(definitions.map((definition) => definition.name)).toEqual(["welcome-email"]);
      const definition = await readFile(definitions[0]!.handler, "utf8");
      expect(definition).toContain('import { defineQueue } from "vite-hub/queue"');
      expect(variant.files.map((file) => file.content).join("\n")).not.toContain("definePrimitive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
