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
// `value` is the index of the first value token, or undefined for a method.
// Returns false when a spread or computed key makes the property list unknown.
function visitObjectProperties(tokens: string[], start: number, visit: (key: string, value: number | undefined) => void): boolean {
  let depth = 0
  let expectKey = true
  let unknown = false
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (depth === 0) {
      if (token === "}") return !unknown
      if (token === ",") { expectKey = true; continue }
      if (expectKey) {
        if (token === "[") return false
        if (token === "." && tokens[i + 1] === "." && tokens[i + 2] === ".") {
          unknown = true
          expectKey = false
          continue
        }
        if (/^[A-Za-z_$][\w$]*$/.test(token) || isStringToken(token)) {
          const key = isStringToken(token) ? token.slice(1, -1) : token
          // A shorthand property `{ telegram }` is its own value.
          const shorthand = !isStringToken(token) && [",", "}"].includes(tokens[i + 1]!)
          visit(key, tokens[i + 1] === ":" ? i + 2 : shorthand ? i : undefined)
          expectKey = false
        }
      }
    }
    if (["{", "(", "["].includes(token)) depth++
    else if (["}", ")", "]"].includes(token)) depth--
  }
  return false
}

// Keys set to `undefined` count as omitted, as they do at runtime.
function staticOptionKeys(tokens: string[], start: number, empty: string): ReadonlySet<string> | undefined {
  if (tokens[start] === empty) return new Set()
  if (tokens[start] !== "{") return undefined
  const keys = new Set<string>()
  return visitObjectProperties(tokens, start, (key, value) => {
    const omitted = value !== undefined && tokens[value] === "undefined" && [",", "}"].includes(tokens[value + 1]!)
    if (!omitted) keys.add(key)
  }) ? keys : undefined
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
  const declarations = moduleObjectDeclarations(tokens)
  const agentBindings = new Map([...agentFactories].map(name => [name, "defineAgent"]))
  const agentNames = new Set(["defineAgent"])
  const uses: Array<DiscoveredChannelUse & { index: number }> = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i - 1] === "." || tokens[i - 1] === "as") continue
    const factory = !isShadowedAt(tokens, i, tokens[i]!, bindings) && factoryCall(tokens, i, bindings, namespaces, known)
    if (factory) uses.push({ index: i, kind: factory.name, optionKeys: staticOptionKeys(tokens, factory.open + 1, ")") })
    // Shorthands count only in the top-level `channels` option of defineAgent(), not in types or other objects.
    const agent = factoryCall(tokens, i, agentBindings, agentNamespaces, agentNames)
    if (!agent || tokens[agent.open + 1] !== "{") continue
    visitObjectProperties(tokens, agent.open + 1, (option, channelsValue) => {
      const channels = channelsValue === undefined ? undefined : localObject(tokens, channelsValue, declarations)
      if (option !== "channels" || channels === undefined) return
      visitObjectProperties(tokens, channels, (key, value) => {
        if (value === undefined) return
        const reference = channelFactoryReference(tokens, value, bindings, namespaces, known)
        // A factory call is found by the call scan. Runtime calls a bare factory without options
        // and uses the kind it returns, whatever the key is.
        if (reference?.call) return
        if (reference) {
          uses.push({ index: value, kind: reference.kind, optionKeys: new Set() })
          return
        }
        if (!known.has(key)) return
        const optionKeys = staticOptionKeys(tokens, localObject(tokens, value, declarations) ?? value, "}")
        // An object with `kind` is a complete Channel definition, not built-in Channel options.
        if (!optionKeys?.has("kind")) uses.push({ index: value, kind: key, optionKeys })
      })
    })
  }
  return uses.sort((left, right) => left.index - right.index).map(({ kind, optionKeys }) => ({ kind, optionKeys }))
}

function channelFactoryReference(
  tokens: string[],
  index: number,
  bindings: ReadonlyMap<string, string>,
  namespaces: ReadonlySet<string>,
  known: ReadonlySet<string>,
): { call: boolean, kind: string } | undefined {
  let kind = bindings.get(tokens[index]!)
  let next = index + 1
  if (!kind && namespaces.has(tokens[index]!) && tokens[index + 1] === "." && known.has(tokens[index + 2]!)) {
    kind = tokens[index + 2]!
    next = index + 3
  }
  return kind ? { call: tokens[next] === "(" || tokens[next] === "<", kind } : undefined
}

// Resolve an object literal, or a module-level `const name = { ... }` reference to one.
function localObject(tokens: string[], index: number, declarations: ReadonlyMap<string, number>): number | undefined {
  if (tokens[index] === "{") return index
  const declaration = declarations.get(tokens[index]!)
  const end = tokens[index + 1]
  return declaration !== undefined && tokens[declaration] === "{" && [",", "}", ")"].includes(end!) ? declaration : undefined
}

function isShadowedAt(tokens: string[], index: number, name: string, bindings: ReadonlyMap<string, string>): boolean {
  if (!bindings.has(name)) return false
  const identifier = /^[A-Za-z_$][\w$]*$/
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "function") continue
    const open = tokens.indexOf("(", i + 1)
    if (open < 0) continue
    let depth = 0
    let close = open
    for (; close < tokens.length; close++) {
      if (["(", "[", "{"].includes(tokens[close]!)) depth++
      else if ([")", "]", "}"].includes(tokens[close]!) && --depth === 0) break
    }
    if (tokens[close + 1] !== "{") continue
    const params = new Set<string>()
    for (let j = open + 1; j < close; j++) if (identifier.test(tokens[j]!)) params.add(tokens[j]!)
    if (!params.has(name)) continue
    let bodyDepth = 0
    let end = close + 1
    for (; end < tokens.length; end++) {
      if (["{", "(", "["].includes(tokens[end]!)) bodyDepth++
      else if (["}", ")", "]"].includes(tokens[end]!) && --bodyDepth === 0) break
    }
    if (index > close && index < end) return true
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "(") continue
    let depth = 1
    let close = i + 1
    for (; close < tokens.length && depth; close++) {
      if (tokens[close] === "(") depth++
      else if (tokens[close] === ")") depth--
    }
    if (tokens[close] !== "=" || tokens[close + 1] !== ">") continue
    const params = new Set(tokens.slice(i + 1, close).filter(token => identifier.test(token)))
    if (!params.has(name)) continue
    const body = close + 2
    if (tokens[body] !== "{") { if (index >= body) return true; continue }
    let bodyDepth = 1
    let end = body + 1
    for (; end < tokens.length && bodyDepth; end++) {
      if (tokens[end] === "{") bodyDepth++
      else if (tokens[end] === "}") bodyDepth--
    }
    if (index > body && index < end) return true
  }
  return false
}

// Map module-level `const name = {` declarations to the index of their opening brace.
function moduleObjectDeclarations(tokens: string[]): Map<string, number> {
  const declarations = new Map<string, number>()
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (depth === 0 && token === "const" && /^[A-Za-z_$][\w$]*$/.test(tokens[i + 1] ?? "")) {
      let equals = i + 2
      while (tokens[equals] && tokens[equals] !== "=" && tokens[equals] !== ";") equals++
      if (tokens[equals] === "=" && tokens[equals + 1] === "{") declarations.set(tokens[i + 1]!, equals + 1)
    }
    if (["{", "(", "["].includes(token)) depth++
    else if (["}", ")", "]"].includes(token)) depth--
  }
  return declarations
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
