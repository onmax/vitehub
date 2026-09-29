import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { builtInChannelEnv } from "./channel-env.ts"
import { discoverAgentDefinitions, tokenizeAgentSource } from "./discovery.ts"

import type { ChannelEnvField } from "./channel-env.ts"

const channelFactoryModules = new Set(["@vite-hub/agent/channels", "vite-hub/agent/channels"])
const agentModules = new Set(["@vite-hub/agent", "vite-hub/agent"])

/** One built-in Channel use in an Agent file. `optionKeys` is undefined when the options are not a static object literal. */
export interface DiscoveredChannelUse {
  kind: string
  optionKeys?: ReadonlySet<string>
}

/** Server Env that the Agents of an application need for their built-in Channels. */
export type AgentChannelEnv = Record<string, Record<string, { names: string[], required: boolean, secret: boolean }>>

function isStringToken(token: string | undefined): boolean {
  return /^["'`]/.test(token ?? "")
}

// Visit the top-level properties of the object literal that opens at `start`.
// Returns false when a spread or computed key makes the property list unknown.
function visitObjectProperties(tokens: string[], start: number, visit: (key: string, value: number | undefined) => void): boolean {
  let depth = 0
  let expectKey = true
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (depth === 0) {
      if (token === "}") return true
      if (token === ",") { expectKey = true; continue }
      if (expectKey) {
        if (token === "." || token === "[") return false
        if (/^[A-Za-z_$][\w$]*$/.test(token) || isStringToken(token)) {
          const key = isStringToken(token) ? token.slice(1, -1) : token
          visit(key, tokens[i + 1] === ":" ? i + 2 : undefined)
          expectKey = false
        }
      }
    }
    if (["{", "(", "["].includes(token)) depth++
    else if (["}", ")", "]"].includes(token)) depth--
  }
  return false
}

function staticOptionKeys(tokens: string[], start: number, empty: string): ReadonlySet<string> | undefined {
  if (tokens[start] === empty) return new Set()
  if (tokens[start] !== "{") return undefined
  const keys = new Set<string>()
  return visitObjectProperties(tokens, start, key => keys.add(key)) ? keys : undefined
}

/**
 * Find built-in Channel factory calls, such as `telegram({ ... })` imported from
 * `vite-hub/agent/channels`, and Channel shorthands such as `channels: { telegram: { ... } }`.
 */
export function discoverBuiltInChannelUses(source: string, kinds: Iterable<string>): DiscoveredChannelUse[] {
  const { tokens } = tokenizeAgentSource(source)
  const known = new Set(kinds)
  const bindings = new Map<string, string>()
  const namespaces = new Set<string>()
  const agentFactories = new Set(["defineAgent"])
  const agentNamespaces = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "import" || tokens[i + 1] === "(" || tokens[i + 1] === "type" || tokens[i - 1] === ".") continue
    let from = i + 1
    while (from < tokens.length && tokens[from] !== "from" && !isStringToken(tokens[from])) from++
    const module = tokens[from] === "from" ? tokens[from + 1]?.slice(1, -1) ?? "" : ""
    const clause = tokens.slice(i + 1, from)
    const channelModule = channelFactoryModules.has(module)
    if (!channelModule && !agentModules.has(module)) continue
    for (let b = 0; b < clause.length; b++) {
      const local = clause[b + 1] === "as" ? clause[b + 2]! : clause[b]!
      if (clause[b] === "*" && clause[b + 1] === "as" && clause[b + 2]) (channelModule ? namespaces : agentNamespaces).add(clause[b + 2]!)
      else if (clause[b - 1] === "as" || clause[b - 1] === "type") continue
      else if (channelModule && known.has(clause[b]!)) bindings.set(local, clause[b]!)
      else if (!channelModule && clause[b] === "defineAgent") agentFactories.add(local)
    }
  }
  // Channel shorthands count only inside defineAgent() arguments, not in types or unrelated objects.
  const agentBindings = new Map([...agentFactories].map(name => [name, "defineAgent"]))
  const agentNames = new Set(["defineAgent"])
  const agentArguments: Array<[number, number]> = []
  const uses: Array<DiscoveredChannelUse & { index: number }> = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i - 1] === "." || tokens[i - 1] === "as") continue
    const factory = factoryCall(tokens, i, bindings, namespaces, known)
    if (factory) uses.push({ index: i, kind: factory.name, optionKeys: staticOptionKeys(tokens, factory.open + 1, ")") })
    const agent = factoryCall(tokens, i, agentBindings, agentNamespaces, agentNames)
    if (agent) agentArguments.push([agent.open, closingToken(tokens, agent.open)])
    if (tokens[i] === "channels" && tokens[i + 1] === ":" && tokens[i + 2] === "{" && agentArguments.some(([open, close]) => i > open && i < close)) {
      visitObjectProperties(tokens, i + 2, (key, value) => {
        if (!known.has(key)) return
        // Factory call values are found by the call scan.
        if (value !== undefined && (bindings.has(tokens[value]!) || namespaces.has(tokens[value]!))) return
        uses.push({ index: value ?? i, kind: key, optionKeys: value === undefined ? undefined : staticOptionKeys(tokens, value, "}") })
      })
    }
  }
  return uses.sort((left, right) => left.index - right.index).map(({ kind, optionKeys }) => ({ kind, optionKeys }))
}

// Match `name(`, `name<T>(`, `namespace.name(`, or `namespace.name<T>(` and return the opening parenthesis.
function factoryCall(
  tokens: string[],
  index: number,
  bindings: ReadonlyMap<string, string>,
  namespaces: ReadonlySet<string>,
  names: ReadonlySet<string>,
): { name: string, open: number } | undefined {
  let name = bindings.get(tokens[index]!)
  let next = index + 1
  if (!name && namespaces.has(tokens[index]!) && tokens[index + 1] === "." && names.has(tokens[index + 2]!)) {
    name = tokens[index + 2]
    next = index + 3
  }
  if (!name) return undefined
  if (tokens[next] === "<") next = skipTypeArguments(tokens, next)
  return tokens[next] === "(" ? { name, open: next } : undefined
}

function skipTypeArguments(tokens: string[], start: number): number {
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i] === "<") depth++
    // The tokenizer splits `=>` into `=` and `>`; an arrow does not close a type argument list.
    else if (tokens[i] === ">" && tokens[i - 1] !== "=" && --depth === 0) return i + 1
  }
  return tokens.length
}

function closingToken(tokens: string[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) depth++
    else if (["}", ")", "]"].includes(tokens[i]!) && --depth === 0) return i
  }
  return tokens.length
}

/**
 * Declare the Server Env of each built-in Channel used by a discovered Agent.
 * A value is required when an Agent uses the Channel with static options that omit it.
 */
export function discoverAgentChannelEnv(options: { rootDir: string, serverDirs?: string[] }): AgentChannelEnv {
  const handlers = new Set([
    ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir: options.rootDir }),
    ...discoverAgentDefinitions({ mode: "server-agents", scanDirs: options.serverDirs ?? [resolve(options.rootDir, "server")] }),
  ].map(definition => definition.handler))
  const fields: Readonly<Record<string, Readonly<Record<string, ChannelEnvField>>>> = builtInChannelEnv
  const declared: AgentChannelEnv = {}
  for (const handler of handlers) {
    for (const { kind, optionKeys } of discoverBuiltInChannelUses(readFileSync(handler, "utf8"), Object.keys(fields))) {
      const group = declared[kind] ??= {}
      for (const [field, spec] of Object.entries(fields[kind] ?? {})) {
        const entry = group[field] ??= { names: [...spec.names], required: false, secret: spec.secret === true }
        if (optionKeys && spec.requiredUnless && !spec.requiredUnless.some(key => optionKeys.has(key))) entry.required = true
      }
    }
  }
  return declared
}
