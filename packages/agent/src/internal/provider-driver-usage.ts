const providerDriverPatterns = [
  // driver: "codex" and the tagged form { kind: "claude-code" }
  /\b(?:driver|kind)\s*:\s*(["'`])(?:codex|claude-code)\1/,
  /\b(?:codexDriver|claudeCodeDriver)\s*\(/,
  // First-party presets that define a Codex Driver.
  /(["'`])(?:@vite-hub\/agent|vite-hub\/agent)\/presets\/(?:workspace|babysitter(?:\/server)?)\1/,
]

/**
 * Reports whether a server module selects a provider Agent Driver. The check reads source text, so it
 * finds literal Driver selections and the first-party presets. A Driver computed at runtime is not found;
 * the Worker build then fails at invocation time with AGENT_R0928.
 */
export function usesProviderAgentDriver(source: string): boolean {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
  return providerDriverPatterns.some(pattern => pattern.test(code))
}

/** Worker builds resolve package imports with the "workerd" or "worker" condition. */
export function resolvesWorkerConditions(conditions: readonly string[] | undefined): boolean {
  return Boolean(conditions?.some(condition => condition === "workerd" || condition === "worker"))
}
