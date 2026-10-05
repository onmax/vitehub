import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const ConnectionsLanding = {
  ...stubLanding("connections", "Connections", "/docs/server-primitives/connections"),
  eyebrow: "ViteHub Connections",
  description: "Keep account credentials and provider APIs behind one typed server contract.",
  tagline: "Connect provider accounts without spreading secrets through your app.",
  accent: "secondary",
  supported: ["Vite", "Nitro"],
} satisfies PrimitiveLanding;
