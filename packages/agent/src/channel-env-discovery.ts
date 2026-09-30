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

function closingDelimiter(tokens: string[], start: number): number {
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) depth++
    else if (["}", ")", "]"].includes(tokens[i]!) && --depth === 0) return i
  }
  return tokens.length
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
        if (["async", "get", "set"].includes(token) && tokens[i + 2] === "(") continue
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
  while (tokens[start] === "(") {
    const close = closingDelimiter(tokens, start)
    const valueEnd = ["{", "("].includes(tokens[start + 1]!) ? closingDelimiter(tokens, start + 1) : start + 1
    // Only unwrap a single expression, not a comma expression or an operation on a literal.
    if (valueEnd !== close - 1) return undefined
    start++
  }
  if (tokens[start] === empty) return new Set()
  if (isUndefinedValue(tokens, start, new Set([",", ")", "}"]))) return new Set()
  if (tokens[start] !== "{") return undefined
  const keys = new Set<string>()
  return visitObjectProperties(tokens, start, (key, value) => {
    const omitted = value !== undefined && isUndefinedValue(tokens, value, new Set([",", "}"]))
    if (!omitted) keys.add(key)
  }) ? keys : undefined
}

/**
 * Find built-in Channel factory calls, such as `telegram({ ... })` imported from
 * `vite-hub/agent/channels`, and Channel shorthands such as `channels: { telegram: { ... } }`.
 */
export function discoverBuiltInChannelUses(source: string, kinds: Iterable<string>): DiscoveredChannelUse[] {
  const { tokens, lineBreaks } = tokenizeAgentSource(source)
  const known = new Set(kinds)
  const bindings = new Map<string, string>()
  const namespaces = new Set<string>()
  const agentFactories = new Set<string>()
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
  const shadowBindings = new Map([...bindings, ...[...namespaces].map(name => [name, name] as const)])
  const agentBindings = new Map([...agentFactories].map(name => [name, "defineAgent"]))
  const agentShadowBindings = new Map([...agentBindings, ...[...agentNamespaces].map(name => [name, name] as const)])
  const agentNames = new Set(["defineAgent"])
  const uses: Array<DiscoveredChannelUse & { index: number }> = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i - 1] === "." || tokens[i - 1] === "as") continue
    const factory = !isShadowedAt(tokens, i, tokens[i]!, shadowBindings, lineBreaks) && factoryCall(tokens, i, bindings, namespaces, known, lineBreaks)
    if (factory) uses.push({ index: i, kind: factory.name, optionKeys: staticOptionKeys(tokens, factory.open + 1, ")") })
    // Shorthands count only in the top-level `channels` option of defineAgent(), not in types or other objects.
    const agent = !isShadowedAt(tokens, i, tokens[i]!, agentShadowBindings, lineBreaks) && factoryCall(tokens, i, agentBindings, agentNamespaces, agentNames, lineBreaks)
    if (!agent || tokens[agent.open + 1] !== "{") continue
    visitObjectProperties(tokens, agent.open + 1, (option, channelsValue) => {
      const channels = channelsValue === undefined ? undefined : localObject(tokens, channelsValue, declarations)
      if (option !== "channels" || channels === undefined) return
      visitObjectProperties(tokens, channels, (key, value) => {
        if (value === undefined) return
        const reference = channelFactoryReference(tokens, value, bindings, namespaces, known)
        if (reference && isShadowedAt(tokens, value, tokens[value]!, shadowBindings, lineBreaks)) return
        // A factory call is found by the call scan. Runtime calls a bare factory without options
        // and uses the kind it returns, whatever the key is.
        if (reference?.call) return
        if (reference) {
          uses.push({ index: value, kind: reference.kind, optionKeys: new Set() })
          return
        }
        if (!known.has(key)) return
        const options = localObject(tokens, value, declarations) ?? value
        const optionKeys = staticOptionKeys(tokens, options, "}")
        // An object with `kind` is a complete Channel definition, not built-in Channel options.
        let complete = false
        if (tokens[options] === "{") visitObjectProperties(tokens, options, (key, value) => {
          const omitted = value !== undefined && isUndefinedValue(tokens, value, new Set([",", "}"]))
          if (key === "kind" && !omitted) complete = true
        })
        if (!complete && !optionKeys?.has("kind")) uses.push({ index: value, kind: key, optionKeys })
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
  const member = tokens[next] === "?" && tokens[next + 1] === "." ? next + 1 : next
  if (!kind && namespaces.has(tokens[index]!) && tokens[member] === "." && known.has(tokens[member + 1]!)) {
    kind = tokens[member + 1]!
    next = member + 2
  }
  if (tokens[next] === "?" && tokens[next + 1] === ".") next += 2
  return kind ? { call: tokens[next] === "(" || tokens[next] === "<", kind } : undefined
}

// A method key belongs directly to an object, class, or interface body. Function
// and statement blocks can instead contain a call followed by a standalone block.
function isMethodContainer(tokens: string[], index: number): boolean {
  const stack: number[] = []
  for (let i = 0; i < index; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) stack.push(i)
    else if (["}", ")", "]"].includes(tokens[i]!)) stack.pop()
  }
  const open = stack.at(-1)
  if (open === undefined || tokens[open] !== "{") return false
  return isObjectOrTypeContainer(tokens, open, stack.at(-2))
}

function isObjectOrTypeContainer(tokens: string[], open: number, outer?: number): boolean {
  const previous = tokens[open - 1]
  if (previous === ":") {
    for (let i = open - 2; i >= 0 && !["{", ";"].includes(tokens[i]!); i--) {
      if (["}", ")", "]"].includes(tokens[i]!)) {
        let depth = 1
        while (i > 0 && depth > 0) {
          i--
          if (["}", ")", "]"].includes(tokens[i]!)) depth++
          else if (["{", "(", "["].includes(tokens[i]!)) depth--
        }
        continue
      }
      if (["const", "let", "var", "function", "type"].includes(tokens[i]!)) return true
    }
    // A colon in a statement container introduces a label or case block.
    if (outer === undefined) return false
    if (tokens[outer] !== "{") return true
    const parents: number[] = []
    for (let i = 0; i < outer; i++) {
      if (["{", "(", "["].includes(tokens[i]!)) parents.push(i)
      else if (["}", ")", "]"].includes(tokens[i]!)) parents.pop()
    }
    return isObjectOrTypeContainer(tokens, outer, parents.at(-1))
  }
  // Class and interface bodies remain declarations even after an extends clause.
  let nested = 0
  for (let i = open - 1; i >= 0; i--) {
    const token = tokens[i]!
    if ([")", "]", "}"].includes(token)) { nested++; continue }
    if (["(", "[", "{"].includes(token)) {
      if (nested > 0) { nested--; continue }
      break
    }
    if (nested > 0) continue
    if (["class", "interface"].includes(token) && tokens[i - 1] !== ".") return true
    if (token === "function" || token === ";") return false
  }
  // Statement blocks have a statement boundary, a control/function header,
  // or an arrow before them. Other braces occur in expressions or types.
  return previous !== undefined && !["{", "}", ";", ")", "else", "do", "try", "catch", "finally", "static"].includes(previous)
    && !(previous === ">" && tokens[open - 2] === "=")
}

function isUndefinedValue(tokens: string[], start: number, terminators: ReadonlySet<string>): boolean {
  if (tokens[start] !== "undefined") return false
  if (terminators.has(tokens[start + 1]!)) return true
  if (!["as", "satisfies"].includes(tokens[start + 1]!)) return false
  let depth = 0
  for (let i = start + 2; i < tokens.length; i++) {
    const token = tokens[i]!
    if (["+", "*", "/", "%"].includes(token) || (["|", "&", "?"].includes(token) && tokens[i + 1] === token)) return false
    if (token === "<") { i = skipTypeArguments(tokens, i) - 1; continue }
    if (["(", "[", "{"].includes(token)) depth++
    else if ([")", "]", "}"].includes(token)) {
      if (depth === 0) return terminators.has(token)
      depth--
    }
    else if (depth === 0 && terminators.has(token)) return true
  }
  return false
}

// Resolve an object literal, or a module-level `const name = { ... }` reference to one.
function localObject(tokens: string[], index: number, declarations: ReadonlyMap<string, number>): number | undefined {
  if (tokens[index] === "{") return index
  const declaration = declarations.get(tokens[index]!)
  const end = tokens[index + 1]
  return declaration !== undefined && tokens[declaration] === "{" && [",", "}", ")", "as", "satisfies"].includes(end!) ? declaration : undefined
}

function isShadowedAt(tokens: string[], index: number, name: string, bindings: ReadonlyMap<string, string>, lineBreaks: ReadonlySet<number>): boolean {
  if (!bindings.has(name)) return false
  if (hasLocalBinding(tokens, index, name)) return true
  const closes = new Map<number, number>()
  const stack: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) stack.push(i)
    else if (["}", ")", "]"].includes(tokens[i]!)) {
      const open = stack.pop()
      if (open !== undefined) closes.set(open, i)
    }
  }
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
    if (!parameterListHasName(tokens, open + 1, close, name, closes)) continue
    let bodyDepth = 0
    let end = close + 1
    for (; end < tokens.length; end++) {
      if (["{", "(", "["].includes(tokens[end]!)) bodyDepth++
      else if (["}", ")", "]"].includes(tokens[end]!) && --bodyDepth === 0) break
    }
    if (index > close && index < end) return true
  }
  // Object and class methods, including constructors, have parameter scopes
  // without the `function` keyword.
  for (let open = 0; open < tokens.length; open++) {
    if (tokens[open] !== "(") continue
    const previous = tokens[open - 1]
    if (["if", "while", "for", "switch", "catch", "with", "function"].includes(previous!)) continue
    const close = closes.get(open)
    const body = close === undefined ? undefined : close + 1
    if (close === undefined || tokens[body!] !== "{") continue
    if (!parameterListHasName(tokens, open + 1, close, name, closes)) continue
    const end = closes.get(body!) ?? body!
    if (index > close && index < end) return true
  }
  // A single arrow parameter may omit parentheses: `telegram => telegram()`.
  for (let parameter = 0; parameter < tokens.length; parameter++) {
    if (tokens[parameter] !== name || tokens[parameter + 1] !== "=" || tokens[parameter + 2] !== ">") continue
    const body = parameter + 3
    if (tokens[body] === "{") {
      const end = closes.get(body) ?? body
      if (index > parameter + 2 && index < end) return true
    } else {
      const end = expressionBodyEnd(tokens, body, lineBreaks)
      if (index >= body && index < end) return true
    }
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
    if (!parameterListHasName(tokens, i + 1, close, name, closes)) continue
    const body = close + 2
    if (tokens[body] !== "{") {
      const end = expressionBodyEnd(tokens, body, lineBreaks)
      if (index >= body && index < end) return true
      continue
    }
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

function parameterListHasName(tokens: string[], start: number, end: number, name: string, closes: ReadonlyMap<number, number>): boolean {
  for (let entry = start; entry < end;) {
    if (tokens[entry] === ",") { entry++; continue }
    let binding = entry
    if (tokens[binding] === ".") binding += 3
    if (bindingPatternHasName(tokens, binding, name, closes)) return true
    const nestedEnd = closes.get(binding)
    entry = nestedEnd !== undefined ? nestedEnd + 1 : binding + 1
    while (entry < end && tokens[entry] !== ",") entry = (closes.get(entry) ?? entry) + 1
  }
  return false
}

function expressionBodyEnd(tokens: string[], start: number, lineBreaks: ReadonlySet<number>): number {
  const stack: string[] = []
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!
    const previous = tokens[i - 1]
    if (stack.length === 0 && i > start && lineBreaks.has(i)
      && /^[A-Za-z_$][\w$]*$/.test(token) && !["in", "instanceof", "as", "satisfies"].includes(token)
      && ([")", "]", "}"].includes(previous!) || (/^[A-Za-z_$][\w$]*$/.test(previous ?? "")
        && !["await", "new", "typeof", "void", "delete", "yield", "in", "instanceof", "as", "satisfies"].includes(previous!)))) return i
    if (token === "(" || token === "[" || token === "{") {
      stack.push(token)
      continue
    }
    if (token === ")" || token === "]" || token === "}") {
      if (stack.length === 0) return i
      stack.pop()
      continue
    }
    if (stack.length === 0 && [",", ";"].includes(token)) return i
  }
  return tokens.length
}

// Lexical declarations shadow the import throughout their block. `var` belongs
// to the enclosing function, including declarations inside a nested block.
function hasLocalBinding(tokens: string[], index: number, name: string): boolean {
  const closes = new Map<number, number>()
  const stack: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) stack.push(i)
    else if (["}", ")", "]"].includes(tokens[i]!)) {
      const open = stack.pop()
      if (open !== undefined) closes.set(open, i)
    }
  }
  const functionBodies = new Set<number>()
  const loopScopes = new Map<number, number>()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "function") {
      const params = tokens.indexOf("(", i + 1)
      const body = (closes.get(params) ?? tokens.length) + 1
      if (tokens[body] === "{") functionBodies.add(body)
    }
    if (tokens[i] === "=" && tokens[i + 1] === ">" && tokens[i + 2] === "{") functionBodies.add(i + 2)
    if (tokens[i] === "for") {
      const params = tokens[i + 1] === "await" ? i + 2 : i + 1
      const close = closes.get(params)
      if (close !== undefined && tokens[close + 1] === "{") loopScopes.set(params, closes.get(close + 1) ?? close)
    }
    // Method bodies have parameters too, but control-flow blocks are lexical scopes.
    if (tokens[i] === "(" && !["if", "while", "for", "switch", "catch", "with"].includes(tokens[i - 1]!)) {
      const body = (closes.get(i) ?? tokens.length) + 1
      if (tokens[body] === "{") functionBodies.add(body)
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const declaration = tokens[i]!
    if (declaration === "catch" && tokens[i + 1] === "(") {
      const body = (closes.get(i + 1) ?? tokens.length) + 1
      if (tokens[body] === "{" && index > body && index < (closes.get(body) ?? body)
        && bindingPatternHasName(tokens, i + 2, name, closes)) return true
    }
    if (!["const", "let", "var", "function", "class"].includes(declaration)) continue
    let scope = -1
    for (const [open, close] of closes) {
      if (tokens[open] !== "{" || open >= i || close <= i) continue
      if (declaration === "var" && !functionBodies.has(open)) continue
      if (open > scope) scope = open
    }
    if (declaration !== "var") for (const open of loopScopes.keys()) {
      if (open < i && (closes.get(open) ?? -1) > i && open > scope) scope = open
    }
    const endOfScope = loopScopes.get(scope) ?? closes.get(scope) ?? tokens.length
    if (index <= scope || index >= endOfScope) continue
    if (declaration === "function" || declaration === "class") {
      const binding = tokens[i + 1] === "*" ? i + 2 : i + 1
      if (tokens[binding] !== name) continue
      // Named expressions bind only inside their own body, unlike declarations.
      if (["=", "(", ":", ",", "return"].includes(tokens[i - 1]!)) {
        const params = declaration === "function" ? tokens.indexOf("(", binding + 1) : -1
        const body = declaration === "function" ? (closes.get(params) ?? tokens.length) + 1 : tokens.indexOf("{", binding + 1)
        if (index !== binding && !(index > body && index < (closes.get(body) ?? body))) continue
      }
      return true
    }
    // Walk declarators without mistaking identifiers in initializers for bindings.
    for (let binding = i + 1; binding < tokens.length;) {
      const end = closes.get(binding)
      if (bindingPatternHasName(tokens, binding, name, closes)) return true
      let next = (end ?? binding) + 1
      while (next < tokens.length && !["=", ",", ";", "in", "of", ")", "}"].includes(tokens[next]!)) next++
      if (tokens[next] === "=") {
        next++
        while (next < tokens.length && ![",", ";", ")", "}"].includes(tokens[next]!)) {
          next = (closes.get(next) ?? next) + 1
          if (["const", "let", "var", "return", "export"].includes(tokens[next]!)) break
        }
      }
      if (tokens[next] !== ",") break
      binding = next + 1
    }
  }
  return false
}

// Computed property keys and default values are expressions, not new bindings.
function bindingPatternHasName(tokens: string[], start: number, name: string, closes: ReadonlyMap<number, number>): boolean {
  if (!["{", "["].includes(tokens[start]!)) return tokens[start] === name
  const end = closes.get(start) ?? start
  for (let entry = start + 1; entry < end;) {
    if (tokens[entry] === ",") { entry++; continue }
    let binding = entry
    if (tokens[entry] === ".") binding += 3
    else if (tokens[start] === "{") {
      const next = (closes.get(entry) ?? entry) + 1
      if (tokens[next] === ":") binding = next + 1
    }
    if (bindingPatternHasName(tokens, binding, name, closes)) return true
    let next = (closes.get(binding) ?? binding) + 1
    while (next < end && tokens[next] !== ",") next = (closes.get(next) ?? next) + 1
    entry = next + 1
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
  lineBreaks: ReadonlySet<number>,
): { name: string, open: number } | undefined {
  let name = bindings.get(tokens[index]!)
  let next = index + 1
  const member = tokens[next] === "?" && tokens[next + 1] === "." ? next + 1 : next
  if (!name && namespaces.has(tokens[index]!) && tokens[member] === "." && names.has(tokens[member + 1]!)) {
    name = tokens[member + 1]
    next = member + 2
  }
  if (!name) return undefined
  if (tokens[next] === "?" && tokens[next + 1] === ".") next += 2
  if (tokens[next] === "<") next = skipTypeArguments(tokens, next)
  if (tokens[next] !== "(") return undefined
  const after = tokens[closingDelimiter(tokens, next) + 1]
  const previous = tokens[index - 1]!
  const afterType = lineBreaks.has(index) && (/^[A-Za-z_$][\w$]*$/.test(previous) || [">", "]"].includes(previous))
    && (!["await", "yield", "return", "throw", "new", "typeof", "void", "delete", "in", "instanceof"].includes(previous) || (previous === "void" && tokens[index - 2] === ":"))
  // Method keys are declarations. A call can precede a ternary colon, so also
  // require the key to follow a property boundary or a method modifier.
  if (["{", ":"].includes(after!) && (afterType || ["{", "}", ",", ";", "async", "get", "set", "*", "static", "public", "private", "protected", "abstract", "declare"].includes(previous)) && isMethodContainer(tokens, index)) return undefined
  return { name, open: next }
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
