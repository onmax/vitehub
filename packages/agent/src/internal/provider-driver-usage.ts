import { parseAst } from "vite"

const providerPackageNames = new Set(["@vite-hub/agent", "vite-hub/agent"])
const capabilityPackageNames = new Set(["@vite-hub/agent/capabilities", "vite-hub/agent/capabilities"])
const providerFactoryNames = new Set(["codexDriver", "claudeCodeDriver"])
const providerCapabilityNames = new Set(["title", "progressSummary"])
const providerPresetPattern = /^(?:@vite-hub\/agent|vite-hub\/agent)\/presets\/(?:workspace|babysitter(?:\/server)?)$/
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

function hasValueImport(specifier: unknown): boolean {
  return isPositionedNode(specifier) && specifier.importKind !== "type"
}

function isProviderFactoryCall(node: PositionedNode, factoryBindings: Set<string>, namespaces: Set<string>): boolean {
  if (node.type !== "CallExpression" || !isPositionedNode(node.callee)) return false
  if (node.callee.type === "Identifier") return factoryBindings.has(identifierName(node.callee) ?? "")
  if (node.callee.type !== "MemberExpression" || node.callee.computed === true) return false
  return namespaces.has(identifierName(node.callee.object) ?? "")
    && providerFactoryNames.has(identifierName(node.callee.property) ?? "")
}

function hasProviderDriverValue(node: PositionedNode): boolean {
  const value = unwrapTypeScriptExpression(node)
  if (value.type === "Literal") {
    const kind = literalString(value)
    return kind !== undefined && providerKinds.has(kind)
  }
  if (value.type !== "ObjectExpression") return false
  const properties = Array.isArray(value.properties) ? value.properties : []
  return properties.some((property) => {
    if (!isPositionedNode(property) || property.type !== "Property" || propertyName(property) !== "kind") return false
    const kind = isPositionedNode(property.value) ? literalString(unwrapTypeScriptExpression(property.value)) : undefined
    return kind !== undefined && providerKinds.has(kind)
  })
}

function objectProperty(node: PositionedNode, name: string): PositionedNode | undefined {
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) return
  const property = node.properties.find((candidate) => {
    return isPositionedNode(candidate) && candidate.type === "Property" && propertyName(candidate) === name
  })
  return isPositionedNode(property) && isPositionedNode(property.value) ? property.value : undefined
}

function isProviderCapabilityCall(node: PositionedNode, capabilityBindings: Set<string>, namespaces: Set<string>): boolean {
  if (node.type !== "CallExpression" || !isPositionedNode(node.callee)) return false
  if (node.callee.type === "Identifier") return capabilityBindings.has(identifierName(node.callee) ?? "")
  if (node.callee.type !== "MemberExpression" || node.callee.computed === true) return false
  return namespaces.has(identifierName(node.callee.object) ?? "")
    && providerCapabilityNames.has(identifierName(node.callee.property) ?? "")
}

function hasProviderCapabilityDriver(node: PositionedNode, capabilityBindings: Set<string>, namespaces: Set<string>): boolean {
  let found = false
  visitNodes(node, (descendant) => {
    if (found || !isProviderCapabilityCall(descendant, capabilityBindings, namespaces)) return
    const options = Array.isArray(descendant.arguments) && isPositionedNode(descendant.arguments[0])
      ? unwrapTypeScriptExpression(descendant.arguments[0])
      : undefined
    const driver = options ? objectProperty(options, "driver") : undefined
    if (driver) found = hasProviderDriverValue(driver)
  })
  return found
}

function hasProviderDriverDefinition(
  node: PositionedNode,
  defineAgentBindings: Set<string>,
  namespaces: Set<string>,
  capabilityBindings: Set<string>,
  capabilityNamespaces: Set<string>,
): boolean {
  if (node.type !== "CallExpression" || !isPositionedNode(node.callee)) return false
  const callee = node.callee
  const isDefineAgent = callee.type === "Identifier"
    ? defineAgentBindings.has(identifierName(callee) ?? "")
    : callee.type === "MemberExpression" && callee.computed !== true
      && namespaces.has(identifierName(callee.object) ?? "")
      && identifierName(callee.property) === "defineAgent"
  if (!isDefineAgent) return false
  const options = Array.isArray(node.arguments) && isPositionedNode(node.arguments[0])
    ? unwrapTypeScriptExpression(node.arguments[0])
    : undefined
  if (!options || options.type !== "ObjectExpression") return false
  const driver = objectProperty(options, "driver")
  if (driver && hasProviderDriverValue(driver)) return true
  const capabilities = objectProperty(options, "capabilities")
  return capabilities ? hasProviderCapabilityDriver(capabilities, capabilityBindings, capabilityNamespaces) : false
}

/** Reports whether a server module selects a provider Agent Driver from statically recognizable syntax. */
export function usesProviderAgentDriver(source: string): boolean {
  const parsed = parseAst(source, { lang: "ts" })
  if (!isPositionedNode(parsed)) return false
  const program = parsed

  const factoryBindings = new Set<string>()
  const defineAgentBindings = new Set<string>()
  const namespaces = new Set<string>()
  const capabilityBindings = new Set<string>()
  const capabilityNamespaces = new Set<string>()
  let hasProviderPreset = false

  visitNodes(program, (node) => {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") return
    const importedSource = literalString(node.source)
    if (!importedSource) return
    const specifiers = Array.isArray(node.specifiers) ? node.specifiers : []
    if (providerPresetPattern.test(importedSource)) {
      if (specifiers.some(hasValueImport)) hasProviderPreset = true
      return
    }
    if (!providerPackageNames.has(importedSource)) {
      if (!capabilityPackageNames.has(importedSource)) return
      for (const rawSpecifier of specifiers) {
        if (!isPositionedNode(rawSpecifier) || rawSpecifier.importKind === "type") continue
        if (rawSpecifier.type === "ImportNamespaceSpecifier") {
          const local = identifierName(rawSpecifier.local)
          if (local) capabilityNamespaces.add(local)
          continue
        }
        const binding = importedBinding(rawSpecifier)
        if (binding && providerCapabilityNames.has(binding.imported)) capabilityBindings.add(binding.local)
      }
      return
    }
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
      || hasProviderDriverDefinition(node, defineAgentBindings, namespaces, capabilityBindings, capabilityNamespaces)
  })
  return found
}

/** Worker builds resolve package imports with the "workerd" or "worker" condition. */
export function resolvesWorkerConditions(conditions: readonly string[] | undefined): boolean {
  return Boolean(conditions?.some(condition => condition === "workerd" || condition === "worker"))
}
