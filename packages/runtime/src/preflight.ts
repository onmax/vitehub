import { Diagnostic, type DiagnosticJSON } from "nostics"
import { defineDiagnostics } from "nostics"

import type { MaybePromise } from "./index.ts"
import { hasRuntimeType, isRuntimeObject } from "./internal/runtime-type.ts"

/** The small set of runtime facts that a preflight check can describe. */
export type RuntimePreflightKind = "browser" | "command" | "file" | "mcp" | "tool" | (string & {})

export type RuntimePreflightState = "available" | "missing" | "unknown"

export type RuntimePreflightValue = string | number | boolean | null

/** Safe, bounded details for a check. Do not put credentials or command output here. */
export type RuntimePreflightDetails = Readonly<Record<string, RuntimePreflightValue>>

export interface RuntimePreflightCheckContext {
  signal: AbortSignal
}

export interface RuntimePreflightCheckResult {
  state: RuntimePreflightState
  details?: RuntimePreflightDetails
  reason?: string
}

export interface RuntimePreflightCheck {
  /** Stable local identifier, for example `command:git` or `file:AGENTS.md`. */
  id: string
  kind: RuntimePreflightKind
  /** Required only affects the diagnostic metadata. Missing optional checks never fail an invocation. */
  required?: boolean
  check: (context: RuntimePreflightCheckContext) => MaybePromise<RuntimePreflightCheckResult | RuntimePreflightState | boolean>
}

export type RuntimePreflightDiagnosticData = Record<string, unknown> & {
  checkId: string
  kind: RuntimePreflightKind
  required: boolean
  state: RuntimePreflightState
}

const preflightDiagnostics = defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics#runtime-preflight",
  codes: {
    RUNTIME_PREFLIGHT_MISSING: {
      why: ({ checkId, kind }: RuntimePreflightDiagnosticData) => `Runtime preflight could not find ${kind} capability "${checkId}".`,
      fix: "Provide the capability in the execution environment, or mark this check optional when the Agent can continue without it.",
      data: (params: RuntimePreflightDiagnosticData) => params,
    },
    RUNTIME_PREFLIGHT_UNKNOWN: {
      why: ({ checkId, kind }: RuntimePreflightDiagnosticData) => `Runtime preflight could not verify ${kind} capability "${checkId}".`,
      fix: "Inspect the check reason and verify the capability from the same runtime that starts the Agent.",
      data: (params: RuntimePreflightDiagnosticData) => params,
    },
  },
})

export interface RuntimePreflightIssue {
  check: Pick<RuntimePreflightCheck, "id" | "kind" | "required">
  state: RuntimePreflightState
  diagnostic: Diagnostic<RuntimePreflightDiagnosticData>
}

export interface RuntimePreflightCheckSummary {
  id: string
  kind: RuntimePreflightKind
  required: boolean
  state: RuntimePreflightState
  details?: RuntimePreflightDetails
  reason?: string
  diagnostic?: DiagnosticJSON<RuntimePreflightDiagnosticData>
}

/** Compact, serializable result suitable for Agent inspection and telemetry. */
export interface RuntimePreflightManifest {
  version: 1
  checkedAt: string
  durationMs: number
  checks: readonly RuntimePreflightCheckSummary[]
  capabilities: Readonly<Record<string, RuntimePreflightState>>
  diagnostics: readonly DiagnosticJSON<RuntimePreflightDiagnosticData>[]
}

export interface RuntimePreflightOptions {
  checks: readonly RuntimePreflightCheck[]
  /** Maximum time allowed for one check. Defaults to 250ms. */
  timeoutMs?: number
  /** Maximum checks run for one preflight. Defaults to 32. */
  maxChecks?: number
  signal?: AbortSignal
  /** Best-effort callback. Its work never delays or fails the manifest. */
  onDiagnostic?: (issue: RuntimePreflightIssue) => MaybePromise<void>
}

export interface RuntimePreflightHandle {
  /** Resolves even when checks fail, time out, or the optional reporter fails. */
  manifest: Promise<RuntimePreflightManifest>
  cancel: () => void
}

const maxReasonLength = 256
const maxDetailCount = 12

function normalizeReason(value: unknown): string | undefined {
  if (!hasRuntimeType(value, "string")) return
  const reason = value.trim()
  return reason ? reason.slice(0, maxReasonLength) : undefined
}

function normalizeDetails(value: unknown): RuntimePreflightDetails | undefined {
  if (!isRuntimeObject(value) || Array.isArray(value)) return
  const details: Record<string, RuntimePreflightValue> = {}
  for (const [key, child] of Object.entries(value)) {
    if (Object.keys(details).length >= maxDetailCount) break
    if (!key || key.length > 64) continue
    if (child === null || hasRuntimeType(child, "string") || hasRuntimeType(child, "number") || hasRuntimeType(child, "boolean")) details[key] = hasRuntimeType(child, "string") ? child.slice(0, maxReasonLength) : child
  }
  return Object.keys(details).length ? details : undefined
}

function normalizeResult(value: unknown): RuntimePreflightCheckResult {
  if (value === true) return { state: "available" }
  if (value === false) return { state: "missing" }
  if (value === "available" || value === "missing" || value === "unknown") return { state: value }
  if (isRuntimeObject(value) && !Array.isArray(value)) {
    // SAFETY: The object guard above establishes the record shape read below.
    const result = value as Partial<RuntimePreflightCheckResult>
    const state = result.state === "available" || result.state === "missing" || result.state === "unknown" ? result.state : "unknown"
    const normalized: RuntimePreflightCheckResult = { state }
    const details = normalizeDetails(result.details)
    if (details) normalized.details = details
    const reason = normalizeReason(result.reason)
    if (reason) normalized.reason = reason
    return normalized
  }
  return { state: "unknown", reason: "The preflight check returned an invalid result." }
}

function timeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal, cancel: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  if (parent.aborted) abort()
  else parent.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Runtime preflight check timed out.")), timeoutMs)
  const cancel = () => {
    clearTimeout(timer)
    parent.removeEventListener("abort", abort)
  }
  return { signal: controller.signal, cancel }
}

async function resolveCheck(check: RuntimePreflightCheck, signal: AbortSignal): Promise<RuntimePreflightCheckResult> {
  let removeAbortListener: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(signal.reason || new Error("Runtime preflight check was aborted."))
    if (signal.aborted) rejectAbort()
    else {
      signal.addEventListener("abort", rejectAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener("abort", rejectAbort)
    }
  })
  const operation = Promise.resolve().then(() => check.check({ signal }))
  // The abort race owns completion, but the check may still reject after it loses the race.
  void operation.catch(() => undefined)
  try {
    return normalizeResult(await Promise.race([operation, aborted]))
  }
  finally { removeAbortListener?.() }
}

function diagnosticFor(check: RuntimePreflightCheck, state: RuntimePreflightState): Diagnostic<RuntimePreflightDiagnosticData> | undefined {
  if (state === "available") return
  const params = { checkId: check.id, kind: check.kind, required: check.required === true, state }
  return state === "missing"
    ? preflightDiagnostics.RUNTIME_PREFLIGHT_MISSING(params)
    : preflightDiagnostics.RUNTIME_PREFLIGHT_UNKNOWN(params)
}

function isRuntimePreflightCheck(value: unknown): value is RuntimePreflightCheck {
  if (!isRuntimeObject(value)) return false
  const id = Reflect.get(value, "id")
  const kind = Reflect.get(value, "kind")
  const check = Reflect.get(value, "check")
  return hasRuntimeType(id, "string") && hasRuntimeType(kind, "string") && hasRuntimeType(check, "function")
}

function validateOptions(options: RuntimePreflightOptions): { checks: RuntimePreflightCheck[], timeoutMs: number, maxChecks: number } {
  if (!options || !Array.isArray(options.checks)) throw new TypeError("[vitehub] Runtime preflight checks must be an array.")
  const timeoutMs = options.timeoutMs ?? 250
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw new TypeError("[vitehub] Runtime preflight timeoutMs must be between 1 and 10000.")
  const maxChecks = options.maxChecks ?? 32
  if (!Number.isSafeInteger(maxChecks) || maxChecks < 1 || maxChecks > 128) throw new TypeError("[vitehub] Runtime preflight maxChecks must be between 1 and 128.")
  const checks = options.checks.slice(0, maxChecks)
  const ids = new Set<string>()
  for (const check of checks) {
    if (!isRuntimePreflightCheck(check) || !check.id.trim() || !check.kind.trim()) {
      throw new TypeError("[vitehub] Runtime preflight checks require an id, kind, and check function.")
    }
    if (ids.has(check.id)) throw new TypeError(`[vitehub] Runtime preflight check "${check.id}" is duplicated.`)
    ids.add(check.id)
  }
  return { checks, timeoutMs, maxChecks }
}

/**
 * Start bounded capability checks without making them part of the invocation's critical path.
 * Checks run in parallel and settle to a manifest; failures are represented as diagnostics.
 */
export function startRuntimePreflight(options: RuntimePreflightOptions): RuntimePreflightHandle {
  const normalized = validateOptions(options)
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener("abort", abort, { once: true })
  let settled = false
  const startedAt = Date.now()
  const manifest = Promise.resolve().then(async () => {
    const summaries = await Promise.all(normalized.checks.map(async check => {
      const bounded = timeoutSignal(controller.signal, normalized.timeoutMs)
      let result: RuntimePreflightCheckResult
      try {
        result = await resolveCheck(check, bounded.signal)
        if (bounded.signal.aborted && !controller.signal.aborted) result = { state: "unknown", reason: "The preflight check timed out." }
      }
      catch (error) {
        result = {
          state: "unknown",
          reason: normalizeReason(error instanceof Error ? error.message : error) || "The preflight check failed.",
        }
      }
      finally { bounded.cancel() }
      const diagnostic = diagnosticFor(check, result.state)
      const issue = diagnostic ? { check, state: result.state, diagnostic } satisfies RuntimePreflightIssue : undefined
      if (issue && options.onDiagnostic) void Promise.resolve(options.onDiagnostic(issue)).catch(() => undefined)
      const summary: RuntimePreflightCheckSummary = {
        id: check.id,
        kind: check.kind,
        required: check.required === true,
        state: result.state,
      }
      if (result.details) summary.details = result.details
      if (result.reason) summary.reason = result.reason
      if (diagnostic) summary.diagnostic = diagnostic.toJSON()
      return summary
    }))
    const capabilities = Object.fromEntries(summaries.map(summary => [summary.id, summary.state]))
    return {
      version: 1 as const,
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      checks: summaries,
      capabilities,
      diagnostics: summaries.flatMap(summary => summary.diagnostic ? [summary.diagnostic] : []),
    }
  }).finally(() => {
    settled = true
    options.signal?.removeEventListener("abort", abort)
  })
  return {
    manifest,
    cancel() {
      if (!settled) controller.abort(new Error("Runtime preflight cancelled."))
    },
  }
}

export async function runRuntimePreflight(options: RuntimePreflightOptions): Promise<RuntimePreflightManifest> {
  return await startRuntimePreflight(options).manifest
}
