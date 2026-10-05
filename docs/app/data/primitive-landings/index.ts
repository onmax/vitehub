import { landingPrimitives } from "~/components/landing/content";
import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

const routeNames: Record<string, string> = {
  agent: "agents",
  workflow: "workflows",
  database: "databases",
  rate-limit: "rate-limits",
};

export const primitiveLandings: Record<string, PrimitiveLanding> = Object.fromEntries(
  landingPrimitives.map((primitive) => {
    const slug = routeNames[primitive.id] ?? primitive.id;
    return [slug, stubLanding(slug, primitive.name, primitive.to)];
  }),
);

export function getPrimitiveLanding(slug: string): PrimitiveLanding | undefined {
  return primitiveLandings[slug];
}
