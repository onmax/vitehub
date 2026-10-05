import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

const sandbox = stubLanding("sandbox", "Sandbox", "/docs/server-primitives/sandbox");

const sandboxFiles = [
  {
    path: "server/sandboxes/release-notes/package.json",
    language: "json",
    content: '{\n  "private": true,\n  "type": "module",\n  "dependencies": {\n    "@vite-hub/sandbox": "latest"\n  },\n  "vitehub": {\n    "sandbox": {\n      "timeout": 30000\n    }\n  }\n}',
  },
  {
    path: "server/sandboxes/release-notes/index.ts",
    language: "typescript",
    content: 'import { defineSandbox } from "@vite-hub/sandbox"\n\nexport default defineSandbox({\n  async run(payload: { notes?: string } = {}) {\n    return { text: payload.notes?.toUpperCase() || "No notes" }\n  },\n})',
  },
  {
    path: "server/release-notes.ts",
    language: "typescript",
    content: 'import { runSandbox } from "@vite-hub/sandbox"\n\nexport function releaseNotes() {\n  return runSandbox("release-notes", { notes: "ship it" })\n}',
  },
];

export const SandboxLanding = {
  ...sandbox,
  eyebrow: "ViteHub Sandbox",
  description: "Run untrusted or isolated work with a clear boundary and a project you can inspect.",
  tagline: "A safe place to run the work your server should not own.",
  accent: "warning",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: sandbox.variants.map(variant => ({
    ...variant,
    files: [...variant.files.slice(0, 2), ...sandboxFiles],
  })),
} satisfies PrimitiveLanding;
