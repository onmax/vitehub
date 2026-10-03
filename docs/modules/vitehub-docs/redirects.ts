/**
 * Removed docs pages and the page that now owns their content.
 * Keep each entry: published package versions and external sites link to these URLs.
 * `/docs/reference/diagnostics` is also the `docsBase` of every package diagnostic catalog.
 */

/** Server Primitive pages that moved from `/docs/server-primitives/<id>` to their own product section. */
const movedServerPrimitives = [
  "auth",
  "blob",
  "browser",
  "channels",
  "connections",
  "content",
  "database",
  "email",
  "env",
  "kv",
  "queue",
  "rate-limit",
  "sandbox",
  "schedule",
  "shell",
  "source",
  "workflows",
  "workspace",
];

/** Capability pages that now live inside the product section of the primitive they expose. */
const primitiveCapabilities = {
  "blob": "blob",
  "browser": "browser",
  "channel-delivery": "channels",
  "db": "database",
  "email": "email",
  "kv": "kv",
  "rate-limit": "rate-limit",
  "sandbox": "sandbox",
  "schedule": "schedule",
  "workspace-shell": "workspace",
} satisfies Record<string, string>;

/** Concept and AI resource pages that moved into the Start section as groups. */
const startGroups = {
  "ai-resources": ["agent-instructions-skills", "markdown-pages", "mcp-server"],
  "concepts": [
    "auth-users-and-agent-invokers",
    "definitions-and-discovery",
    "runtime-context",
    "runtime-helpers-and-stable-imports",
    "runtime-policy-approvals-and-traces",
    "vite-integrations-and-provider-output",
    "workspace-and-sources",
  ],
} satisfies Record<string, string[]>;

/** Capability pages that have no primitive and moved under the Agents section. */
const agentCapabilities = {
  "access": "access",
  "chat": "chat",
  "chat-summary": "chat-summary",
  "custom-capabilities": "custom",
  "diagnostics": "diagnostics",
  "fetch": "fetch",
  "git": "git",
  "gmail": "gmail",
  "input-commands": "input-commands",
  "llm-gate": "llm-gate",
  "llm-route": "llm-route",
  "mcp": "mcp",
  "memory": "memory",
  "official-capabilities": "official",
  "openapi": "openapi",
  "otlp": "otlp",
  "papercuts": "papercuts",
  "progress-summary": "progress-summary",
  "skills": "skills",
  "title": "title",
  "transcribe": "transcribe",
  "usage": "usage",
  "web-search": "web-search",
} satisfies Record<string, string>;

export const docsPageRedirects = {
  "/docs/agents/evlog": "/docs/agents/observability",
  "/docs/ai-resources": "/docs/getting-started/ai-resources",
  "/docs/concepts": "/docs/getting-started/concepts",
  "/docs/capabilities": "/docs/agents/capabilities",
  "/docs/concepts/agent-invocations": "/docs/agents/invocations",
  "/docs/concepts/bash": "/docs/workspace/agent-capability",
  "/docs/concepts/capabilities-api": "/docs/agents/capabilities",
  "/docs/concepts/channels-api": "/docs/agents/channels",
  "/docs/concepts/server-primitives-for-any-host": "/docs/getting-started/server-primitives",
  "/docs/console/usage": "/docs/development/console",
  "/docs/reference/channels": "/docs/channels",
  "/docs/reference/diagnostics": "/docs/reference/errors-diagnostics",
  "/docs/reference/realtime": "/docs/realtime",
  "/docs/server-primitives": "/docs/getting-started/server-primitives",
  "/docs/server-primitives/env-bridge": "/docs/env/bridge",
  ...Object.fromEntries(movedServerPrimitives.map(id => [`/docs/server-primitives/${id}`, `/docs/${id}`])),
  ...Object.fromEntries(Object.entries(primitiveCapabilities).map(([id, section]) => [`/docs/capabilities/${id}`, `/docs/${section}/agent-capability`])),
  ...Object.fromEntries(Object.entries(agentCapabilities).map(([id, page]) => [`/docs/capabilities/${id}`, `/docs/agents/capabilities/${page}`])),
  ...Object.fromEntries(Object.entries(startGroups).flatMap(([dir, pages]) => pages.map(page => [`/docs/${dir}/${page}`, `/docs/getting-started/${dir}/${page}`]))),
} satisfies Record<string, string>;

function rawMarkdownPath(path: string) {
  return `/raw${path}.md`;
}

/** Permanent redirects for each removed HTML page, its trailing-slash form, and its raw Markdown copy. */
export function createDocsRedirectRouteRules(redirects: Record<string, string> = docsPageRedirects) {
  const routeRules: Record<string, { redirect: { statusCode: 301, to: string } }> = {};

  for (const [from, to] of Object.entries(redirects)) {
    routeRules[from] = { redirect: { statusCode: 301, to } };
    routeRules[`${from}/`] = { redirect: { statusCode: 301, to } };
    routeRules[rawMarkdownPath(from)] = { redirect: { statusCode: 301, to: rawMarkdownPath(to) } };
  }

  return routeRules;
}
