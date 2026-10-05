import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const WorkspaceLanding = {
  ...stubLanding("workspace", "Workspace", "/docs/server-primitives/workspace"),
  eyebrow: "ViteHub Workspace",
  description: "Give every Agent a persistent file tree with explicit access and predictable state.",
  tagline: "A persistent file tree for work that needs to continue.",
  accent: "info",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
