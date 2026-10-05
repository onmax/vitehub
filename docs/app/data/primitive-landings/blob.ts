import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const BlobLanding = {
  ...stubLanding("blob", "Blob", "/docs/server-primitives/blob"),
  eyebrow: "ViteHub Blob",
  description: "Upload and serve files through a host aware API without changing the application code.",
  tagline: "Files that can move with your deployment.",
  accent: "info",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
