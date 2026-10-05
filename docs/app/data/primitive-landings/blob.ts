import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const BlobLanding = {
  ...stubLanding("blob", "Blob", "/docs/server-primitives/blob"),
  eyebrow: "ViteHub Blob",
  description: "Upload and serve files through a host aware API without changing the application code.",
  tagline: "Files that can move with your deployment.",
  accent: "info",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: [
    {
      framework: "vite",
      label: "Vite",
      files: [
        { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
        {
          path: "vite.config.ts",
          language: "typescript",
          content: 'import { hubBlob } from "@vite-hub/blob/vite"\nimport { defineConfig } from "vite"\n\nexport default defineConfig({\n  blob: { driver: "fs" },\n  plugins: [hubBlob()],\n})',
        },
        {
          path: "blob.ts",
          language: "typescript",
          content: 'import { blob } from "@vite-hub/blob"\n\nexport async function saveGreeting() {\n  return blob.put("greeting.txt", "Hello from Blob", { contentType: "text/plain" })\n}',
        },
      ],
    },
    {
      framework: "nitro",
      label: "Nitro",
      files: [
        { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
        {
          path: "nitro.config.ts",
          language: "typescript",
          content: 'import { hubBlob } from "@vite-hub/blob/vite"\nimport { defineNitroConfig } from "nitropack/config"\n\nexport default defineNitroConfig({\n  vite: { plugins: [hubBlob({ driver: "fs" })] },\n})',
        },
        {
          path: "server/api/blob.ts",
          language: "typescript",
          content: 'import { blob } from "@vite-hub/blob"\nimport { defineEventHandler } from "h3"\n\nexport default defineEventHandler(() => blob.get("greeting.txt"))',
        },
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: 'import { hubBlob } from "@vite-hub/blob/vite"\n\nexport default defineNuxtConfig({\n  modules: ["vite-hub/nuxt"],\n  vite: { plugins: [hubBlob({ driver: "fs" })] },\n})',
        },
        {
          path: "server/api/blob.ts",
          language: "typescript",
          content: 'import { blob } from "@vite-hub/blob"\nimport { defineEventHandler } from "h3"\n\nexport default defineEventHandler(() => blob.get("greeting.txt"))',
        },
      ],
    },
  ],
} satisfies PrimitiveLanding;
