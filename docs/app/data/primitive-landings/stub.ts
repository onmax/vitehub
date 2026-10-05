import type { PrimitiveLanding } from "./types";

export function stubLanding(slug: string, name: string, docsTo: string): PrimitiveLanding {
  return {
    slug,
    name,
    eyebrow: "ViteHub primitive",
    description: `${name} for every Vite host. Start from a working project and keep the same server contract as you move between frameworks.`,
    tagline: `Build with ${name}. Keep the shape of your server code.`,
    accent: "primary",
    supported: ["Vite", "Nitro", "Nuxt"],
    docsTo,
    variants: [
      {
        framework: "vite",
        label: "Vite",
        files: [
          { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
          { path: "vite.config.ts", language: "typescript", content: 'import { viteHub } from "vite-hub/vite"\n\nexport default {\n  plugins: [viteHub()]\n}' },
          { path: `${slug}.ts`, language: "typescript", content: `import { definePrimitive } from "vite-hub/${slug}"\n\nexport default definePrimitive({})` },
        ],
      },
      {
        framework: "nitro",
        label: "Nitro",
        files: [
          { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
          { path: "nitro.config.ts", language: "typescript", content: 'import { defineNitroConfig } from "nitropack/config"\n\nexport default defineNitroConfig({})' },
          { path: `server/${slug}s/index.ts`, language: "typescript", content: `import { definePrimitive } from "vite-hub/${slug}"\n\nexport default definePrimitive({})` },
        ],
      },
      {
        framework: "nuxt",
        label: "Nuxt",
        files: [
          { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
          { path: "nuxt.config.ts", language: "typescript", content: 'export default defineNuxtConfig({\n  modules: ["vite-hub/nuxt"]\n})' },
          { path: `server/${slug}s/index.ts`, language: "typescript", content: `import { definePrimitive } from "vite-hub/${slug}"\n\nexport default definePrimitive({})` },
        ],
      },
    ],
  };
}
