import { parseAst } from "vite"

const providerPackageNames = new Set(["@vite-hub/agent", "vite-hub/agent"])
const providerFactoryNames = new Set(["codexDriver", "claudeCodeDriver"])
const providerPresetPattern = /\/presets\/(?:workspace|babysitter(?:\/server)?)$/
const providerKinds = new Set(["codex", "claude-code"])

interface PositionedNode {
  end: number
  start: number
  type: string
  [key: string]: unknown
}

function isPositionedNode(value: unknown): value is PositionedNode {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as PositionedNode).type === "string"
    && typeof (value as PositionedNode).start === "number"
    && typeof (value as PositionedNode).end === "number",
  )
}

function visitNodes(node: PositionedNode, visit: (node: PositionedNode) => void): void {
  visit(node)
  for (const value of Object.values(node)) {
    if (isPositionedNode(value)) visitNodes(value, visit)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (isPositionedNode(item)) visitNodes(item, visit)
      }
    }
  }
}

function identifierName(value: unknown): string | undefined {
  return isPositionedNode(value) && value.type === "Identifier" && typeof value.name === "string" ? value.name : undefined
}

function literalString(value: unknown): string | undefined {
  return isPositionedNode(value) && value.type === "Literal" && typeof value.value === "string" ? value.value : undefined
}

function unwrapTypeScriptExpression(node: PositionedNode): PositionedNode {
  let expression = node
  while (
    expression.type === "TSAsExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSNonNullExpression"
  ) {
    const inner = expression.expression
    if (!isPositionedNode(inner)) break
    expression = inner
  }
  return expression
}

function propertyName(node: PositionedNode): string | undefined {
  if (node.computed === true) return
  return identifierName(node.key) ?? literalString(node.key)
}

function importedBinding(specifier: PositionedNode): { imported: string, local: string } | undefined {
  if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") return
  const imported = identifierName(specifier.imported) ?? literalString(specifier.imported)
  const local = identifierName(specifier.local)
  return imported && local ? { imported, local } : undefined
}

function isProviderFactoryCall(node: PositionedNode, factoryBindings: Set<string>, namespaces: Set<string>): boolean {
  if (node.type !== "CallExpression" || !isPositionedNode(node.callee)) return false
  if (node.callee.type === "Identifier") return factoryBindings.has(node.callee.name as string)
  if (node.callee.type !== "MemberExpression" || node.callee.computed === true) return false
  return namespaces.has(identifierName(node.callee.object) ?? "")
    && providerFactoryNames.has(identifierName(node.callee.property) ?? "")
}

function hasProviderDriverValue(node: PositionedNode): boolean {
  const value = unwrapTypeScriptExpression(node)
  if (value.type === "Literal") return providerKinds.has(value.value as string)
  if (value.type !== "ObjectExpression") return false
  const properties = Array.isArray(value.properties) ? value.properties : []
  return properties.some((property) => {
    if (!isPositionedNode(property) || property.type !== "Property" || propertyName(property) !== "kind") return false
    const kind = isPositionedNode(property.value) ? literalString(unwrapTypeScriptExpression(property.value)) : undefined
    return kind !== undefined && providerKinds.has(kind)
  })
}

function hasProviderDriverDefinition(node: PositionedNode, defineAgentBindings: Set<string>, namespaces: Set<string>): boolean {
  if (node.type !== "CallExpression" || !isPositionedNode(node.callee)) return false
  const callee = node.callee
  const isDefineAgent = callee.type === "Identifier"
    ? defineAgentBindings.has(callee.name as string)
    : callee.type === "MemberExpression" && callee.computed !== true
      && namespaces.has(identifierName(callee.object) ?? "")
      && identifierName(callee.property) === "defineAgent"
  if (!isDefineAgent) return false
  const options = Array.isArray(node.arguments) && isPositionedNode(node.arguments[0])
    ? unwrapTypeScriptExpression(node.arguments[0])
    : undefined
  if (!options || options.type !== "ObjectExpression") return false
  let found = false
  visitNodes(options, (descendant) => {
    if (found || descendant.type !== "Property" || propertyName(descendant) !== "driver") return
    if (isPositionedNode(descendant.value)) found = hasProviderDriverValue(descendant.value)
  })
  return found
}

/** Reports whether a server module selects a provider Agent Driver from statically recognizable syntax. */
export function usesProviderAgentDriver(source: string): boolean {
  const program = parseAst(source, { lang: "ts" }) as unknown as PositionedNode

  const factoryBindings = new Set<string>()
  const defineAgentBindings = new Set<string>()
  const namespaces = new Set<string>()
  let hasProviderPreset = false

  visitNodes(program, (node) => {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") return
    const importedSource = literalString(node.source)
    if (!importedSource || !providerPackageNames.has(importedSource)) {
      if (importedSource && providerPresetPattern.test(importedSource)) hasProviderPreset = true
      return
    }
    const specifiers = Array.isArray(node.specifiers) ? node.specifiers : []
    for (const rawSpecifier of specifiers) {
      if (!isPositionedNode(rawSpecifier) || rawSpecifier.importKind === "type") continue
      if (rawSpecifier.type === "ImportNamespaceSpecifier") {
        const local = identifierName(rawSpecifier.local)
        if (local) namespaces.add(local)
        continue
      }
      const binding = importedBinding(rawSpecifier)
      if (!binding) continue
      if (binding.imported === "defineAgent") defineAgentBindings.add(binding.local)
      if (providerFactoryNames.has(binding.imported)) factoryBindings.add(binding.local)
    }
  })
  if (hasProviderPreset) return true

  let found = false
  visitNodes(program, (node) => {
    if (found) return
    found = isProviderFactoryCall(node, factoryBindings, namespaces)
      || hasProviderDriverDefinition(node, defineAgentBindings, namespaces)
  })
  return found
}

/** Worker builds resolve package imports with the "workerd" or "worker" condition. */
export function resolvesWorkerConditions(conditions: readonly string[] | undefined): boolean {
  return Boolean(conditions?.some(condition => condition === "workerd" || condition === "worker"))
}
