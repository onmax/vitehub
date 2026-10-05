import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const AgentsLanding = {
  ...stubLanding("agents", "Agents", "/docs/agents"),
  eyebrow: "ViteHub Agents",
  description: "Give coding Agents a real workspace, tools, and a portable runtime that can move with your app.",
  tagline: "Build Agents that can act in a real project and keep their context.",
  accent: "secondary",
  supported: ["Vite" , "Nitro" , "Nuxt"],
} satisfies PrimitiveLanding;
