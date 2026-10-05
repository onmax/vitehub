import * as v from "valibot"
import { createRule, defineDoctorDiagnostics, defineDoctorExtension, defineRulePack } from "vite-doctor/extension"
import type { DoctorExtension, DoctorRule, RuleContext } from "vite-doctor/extension"

import frameworkPackageManifest from "../package.json" with { type: "json" }

const diagnostics = defineDoctorDiagnostics(
  [
    { code: "VHUB0001", ruleId: "vitehub/no-internal-imports" },
    { code: "VHUB0002", ruleId: "vitehub/no-server-imports-in-client" },
    { code: "VHUB0003", ruleId: "vitehub/destructure-storage-results" },
  ],
  { docsBase: code => `https://vitehub.dev/docs/reference/doctor-rules#${code.toLowerCase()}` },
)

const identifierSchema = v.object({ type: v.literal("Identifier"), name: v.string() })
const moduleSourceSchema = v.object({
  type: v.picklist(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]),
  source: v.object({ value: v.string() }),
  importKind: v.optional(v.string()),
  exportKind: v.optional(v.string()),
})
const importDeclarationSchema = v.object({
  type: v.literal("ImportDeclaration"),
  source: v.object({ value: v.string() }),
  specifiers: v.array(v.object({
    type: v.string(),
    imported: v.optional(identifierSchema),
    local: identifierSchema,
  })),
})
const wrapperSchema = v.object({
  type: v.picklist(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"]),
  expression: v.unknown(),
})
const memberCallSchema = v.object({
  type: v.literal("CallExpression"),
  callee: v.object({
    type: v.literal("MemberExpression"),
    computed: v.literal(false),
    object: v.unknown(),
    property: identifierSchema,
  }),
})
const awaitSchema = v.object({ type: v.literal("AwaitExpression"), argument: v.unknown() })
const arrayPatternSchema = v.object({ type: v.literal("ArrayPattern") })
const resultUseSchema = v.variant("type", [
  v.object({ type: v.literal("VariableDeclarator"), id: v.unknown(), init: v.unknown() }),
  v.object({ type: v.literal("AssignmentExpression"), left: v.unknown(), right: v.unknown() }),
  v.object({ type: v.literal("LogicalExpression"), left: v.unknown(), right: v.unknown() }),
  v.object({ type: v.literal("UnaryExpression"), operator: v.string(), argument: v.unknown() }),
  v.object({ type: v.literal("MemberExpression"), object: v.unknown() }),
  v.object({ type: v.literal("IfStatement"), test: v.unknown() }),
  v.object({ type: v.literal("WhileStatement"), test: v.unknown() }),
  v.object({ type: v.literal("DoWhileStatement"), test: v.unknown() }),
  v.object({ type: v.literal("ConditionalExpression"), test: v.unknown() }),
])
const numericIndexSchema = v.object({
  type: v.literal("MemberExpression"),
  computed: v.literal(true),
  property: v.object({ type: v.literal("Literal"), value: v.number() }),
})

function moduleSpecifier(node: unknown) {
  if (!v.is(moduleSourceSchema, node)) return
  return {
    specifier: node.source.value,
    typeOnly: node.importKind === "type" || node.exportKind === "type",
  }
}

const generatedFile = /(?:^|\/)\.vitehub\//
const generatedImport = /(?:^|\/)\.vitehub(?:\/|$)/
const internalImport = /^(?:vite-hub\/_internal|@vite-hub\/internal|@vite-hub\/[^/]+\/_?internal)(?:\/|$)/

export const noInternalImports: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-internal-imports",
    title: "Import ViteHub through its public paths",
    category: "imports",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (generatedFile.test(ctx.file.relativePath)) return
    return {
      ScriptNode(node) {
        const specifier = moduleSpecifier(node)?.specifier
        if (!specifier) return
        if (generatedImport.test(specifier)) {
          ctx.report(diagnostics.diagnostics.VHUB0001({
            why: `\`${specifier}\` imports a file that ViteHub generates. ViteHub can replace or remove generated files on the next build.`,
            fix: "Import the stable `#vitehub/*` alias or the `vite-hub/*` path that the ViteHub import paths reference lists.",
          }), { range: ctx.range(node) })
        }
        else if (internalImport.test(specifier)) {
          ctx.report(diagnostics.diagnostics.VHUB0001({
            why: `\`${specifier}\` is an internal ViteHub path. Only generated ViteHub code and package implementations use it, and it can change in any release.`,
            fix: "Import the public `vite-hub/*` path for this feature. The ViteHub import paths reference lists each one.",
          }), { range: ctx.range(node) })
        }
      },
    }
  },
})

const serverOnlyImports = new Set([
  "#vitehub/env/server",
  "@vite-hub/database/drizzle",
  "@vite-hub/env/secret",
  "vite-hub/database/drizzle",
  "vite-hub/env/secret",
])
const serverSubpath = /^(?:vite-hub|@vite-hub\/[^/]+)(?:\/[^/]+)*\/server(?:\/|$)/
const clientAppDirs = ["components", "composables", "layouts", "middleware", "pages", "plugins", "stores", "utils"]

function isClientFile(ctx: RuleContext) {
  const path = ctx.file.relativePath
  if (/(?:^|\/)server\//.test(path) || /\.server\.[^/]+$/.test(path)) return false
  if (path.endsWith(".vue")) return true
  return ctx.project.framework === "nuxt" && clientAppDirs.some(dir => ctx.file.inAppDir(dir))
}

export const noServerImportsInClient: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-server-imports-in-client",
    title: "Keep server-only ViteHub imports out of client code",
    category: "security",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (!isClientFile(ctx)) return
    return {
      ScriptNode(node) {
        const source = moduleSpecifier(node)
        if (!source || source.typeOnly || !(serverOnlyImports.has(source.specifier) || serverSubpath.test(source.specifier))) return
        ctx.report(diagnostics.diagnostics.VHUB0002({
          why: `\`${source.specifier}\` is server-only, and \`${ctx.file.relativePath}\` runs in the browser. ViteHub does not block this import, so the client bundle can include server code and Server Env values.`,
          fix: "Move this code to a server route under `server/` and call that route from the client. Use `#vitehub/env/public` for values that the browser can read.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

const storageModules = new Map([
  ["vite-hub/kv", "kv"],
  ["@vite-hub/kv", "kv"],
  ["vite-hub/blob", "blob"],
  ["@vite-hub/blob", "blob"],
])
const storageMethods = new Set([
  "clear", "createMultipartUpload", "del", "get", "getAndDelete", "handleMultipartUpload", "handleUpload", "has",
  "head", "increment", "keys", "list", "put", "resumeMultipartUpload", "serve", "set", "sign",
])

function unwrap(node: unknown): unknown {
  return v.is(wrapperSchema, node) ? unwrap(node.expression) : node
}

export const destructureStorageResults: DoctorRule = createRule({
  meta: {
    id: "vitehub/destructure-storage-results",
    title: "Destructure KV and Blob results",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    const helpers = new Set<string>()
    const shadowed = new Set<string>()
    const stores = new Set<string>()
    // Nuxt auto-imports `kv` and `blob` into server files when those features are on.
    const autoImports = ctx.project.framework === "nuxt" && ctx.file.relativePath.startsWith("server/")
      ? new Set(storageModules.values())
      : new Set<string>()

    function isHelper(node: unknown) {
      if (!v.is(identifierSchema, node)) return false
      return helpers.has(node.name) || (autoImports.has(node.name) && !shadowed.has(node.name))
    }

    function isStorage(node: unknown): boolean {
      const target = unwrap(node)
      if (isHelper(target)) return true
      if (v.is(identifierSchema, target)) return stores.has(target.name)
      return v.is(memberCallSchema, target) && target.callee.property.name === "store" && isStorage(target.callee.object)
    }

    function storageCall(node: unknown) {
      const target = unwrap(node)
      if (!v.is(awaitSchema, target)) return
      const call = unwrap(target.argument)
      if (!v.is(memberCallSchema, call)) return
      const method = call.callee.property.name
      if (!storageMethods.has(method) || !isStorage(call.callee.object)) return
      return { method, node: target }
    }

    function check(value: unknown) {
      const call = storageCall(value)
      if (!call) return
      ctx.report(diagnostics.diagnostics.VHUB0003({
        why: `\`${call.method}()\` returns an \`[error, value]\` tuple and does not throw on provider failures. This code uses the tuple as the value. A tuple is always truthy, and the error is lost.`,
        fix: `Destructure the result and handle the error: \`const [error, value] = await store.${call.method}(...)\`, then \`if (error) throw error\`.`,
      }), { range: ctx.range(call.node) })
    }

    return {
      ScriptNode(node) {
        if (v.is(importDeclarationSchema, node)) {
          const name = storageModules.get(node.source.value)
          for (const specifier of node.specifiers) {
            if (name && specifier.imported?.name === name) helpers.add(specifier.local.name)
            else shadowed.add(specifier.local.name)
          }
          return
        }
        if (!v.is(resultUseSchema, node)) return
        switch (node.type) {
          case "VariableDeclarator": {
            if (v.is(identifierSchema, node.id)) shadowed.add(node.id.name)
            const init = unwrap(node.init)
            if (v.is(identifierSchema, node.id) && v.is(memberCallSchema, init) && init.callee.property.name === "store" && isStorage(init.callee.object)) {
              stores.add(node.id.name)
            }
            else if (!v.is(arrayPatternSchema, node.id)) check(node.init)
            return
          }
          case "AssignmentExpression":
            if (!v.is(arrayPatternSchema, node.left)) check(node.right)
            return
          case "LogicalExpression":
            check(node.left)
            check(node.right)
            return
          case "UnaryExpression":
            if (node.operator === "!") check(node.argument)
            return
          case "MemberExpression":
            if (!v.is(numericIndexSchema, node)) check(node.object)
            return
          default:
            check(node.test)
        }
      },
    }
  },
})

const vitehubDoctorExtension: DoctorExtension = defineDoctorExtension({
  name: "vite-hub",
  rulePacks: [
    defineRulePack({
      name: "vitehub",
      version: frameworkPackageManifest.version,
      rules: [noInternalImports, noServerImportsInClient, destructureStorageResults],
      diagnostics,
      presets: {
        recommended: [
          "vitehub/no-internal-imports",
          "vitehub/no-server-imports-in-client",
          "vitehub/destructure-storage-results",
        ],
      },
    }),
  ],
})

export default vitehubDoctorExtension
