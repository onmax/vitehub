import { registerViteHubDevEndpoint } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionValue } from "@vite-hub/internal/inspect"

import { resolveWorkflowDevSupport, workflowDevHeader, workflowDevHeaderValue, workflowDevRoute } from "./dev-support.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteHubDevEndpointServer } from "@vite-hub/internal/dev-endpoint"
import type { WorkflowDevDiscovery, WorkflowDevOperation, WorkflowDevRequest, WorkflowDevResponseBody, WorkflowDevRunView } from "./dev-support.ts"
import type { WorkflowProvider, WorkflowRun, WorkflowSignalResult } from "./types.ts"

/**
 * Workflow runtime client that the dev endpoint calls. The Vite plugin loads
 * it through the Vite SSR module graph, so it shares state with the
 * Workflow Definitions that it runs.
 */
export interface WorkflowDevRuntime {
  cancelWorkflow: (name: string, id: string) => Promise<WorkflowRun<unknown, unknown>>
  getWorkflowRun: (name: string, id: string) => Promise<WorkflowRun<unknown, unknown>>
  resumeWorkflowSignal: (token: string, payload: unknown) => Promise<WorkflowSignalResult>
  runWorkflow: (name: string, payload?: unknown) => Promise<WorkflowRun<unknown, unknown>>
}

export interface WorkflowDevState {
  error?: string
  provider: WorkflowProvider | null
  root: string
  workflows: string[]
}

export interface WorkflowDevHandlerOptions {
  loadRuntime: () => Promise<WorkflowDevRuntime>
  state: () => WorkflowDevState
}

export interface WorkflowDevResult {
  body: WorkflowDevResponseBody
  status: number
}

export interface WorkflowDevHandler {
  discover: () => WorkflowDevDiscovery
  execute: (body: unknown) => Promise<WorkflowDevResult>
}

const maxRequestBytes = 1024 * 1024
const maxRememberedRuns = 1024
const credentialUrlPattern = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function failure(status: number, code: string, message: string): WorkflowDevResult {
  return { body: { error: { code, message } }, status }
}

function redactMessage(message: string): string {
  return message.replace(credentialUrlPattern, "$1[redacted]@")
}

function parseRequest(body: unknown): WorkflowDevRequest | undefined {
  if (!isRecord(body)) return
  const operation = body.operation
  if (operation === "start") {
    if (typeof body.workflow !== "string" || !body.workflow) return
    return { operation, workflow: body.workflow, ...("input" in body ? { input: body.input } : {}) }
  }
  if (operation === "get" || operation === "cancel") {
    if (typeof body.runId !== "string" || !body.runId) return
    if (body.workflow !== undefined && (typeof body.workflow !== "string" || !body.workflow)) return
    return { operation, runId: body.runId, ...(typeof body.workflow === "string" ? { workflow: body.workflow } : {}) }
  }
  if (operation === "resume") {
    if (typeof body.token !== "string" || !body.token) return
    return { operation, token: body.token, ...("payload" in body ? { payload: body.payload } : {}) }
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Error) return serializeError(value)
  if (value instanceof Response) return { response: { status: value.status, statusText: value.statusText } }
  return value
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const text = JSON.stringify(value, jsonReplacer)
    return text === undefined ? undefined : redactInspectionValue(JSON.parse(text))
  }
  catch {
    return "[unserializable]"
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return
  const code = Reflect.get(error, "code")
  return typeof code === "string" ? code : undefined
}

function serializeError(error: Error): { code?: string, message: string, name?: string } {
  const code = errorCode(error)
  return {
    ...(code ? { code } : {}),
    message: redactMessage(error.message),
    ...(error.name && error.name !== "Error" ? { name: error.name } : {}),
  }
}

function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  return typeof value === "string" ? value : undefined
}

function isErrorLike(value: unknown): value is Error {
  return value instanceof Error || (isRecord(value) && typeof value.message === "string")
}

// Inline runs store the handler result as a serialized `Response`. Read its body
// so that the CLI shows the value that the Workflow returned.
async function readResult(result: unknown): Promise<unknown> {
  if (!(result instanceof Response)) return result
  const text = await result.clone().text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

/**
 * Converts a runtime Workflow run to JSON data. The view omits the start
 * payload and redacts credentials in the metadata, result, and error message.
 */
export async function toWorkflowDevRunView(run: WorkflowRun<unknown, unknown>, workflow: string): Promise<WorkflowDevRunView> {
  const createdAt = toIsoDate(run.createdAt)
  const startedAt = toIsoDate(run.startedAt)
  const completedAt = toIsoDate(run.completedAt)
  const error = run.status === "failed" && isErrorLike(run.metadata) ? serializeError(run.metadata) : undefined
  const metadata = error ? undefined : toJsonValue(run.metadata)
  const result = toJsonValue(await readResult(run.result))
  return {
    ...(completedAt ? { completedAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(error ? { error } : {}),
    id: run.id,
    ...(metadata === undefined ? {} : { metadata }),
    provider: run.provider,
    ...(result === undefined ? {} : { result }),
    ...(startedAt ? { startedAt } : {}),
    status: run.status,
    workflow,
  }
}

function unsupportedMessage(operation: WorkflowDevOperation, provider: WorkflowProvider | null, note: string): string {
  return provider
    ? `workflow ${operation} is not supported by the local ${provider} dev runtime. ${note}`
    : `workflow ${operation} is not available. ${note}`
}

function runtimeFailure(operation: WorkflowDevOperation, provider: WorkflowProvider, error: unknown): WorkflowDevResult {
  const code = errorCode(error)
  if (code === "WORKFLOW_OPERATION_UNSUPPORTED") {
    return failure(501, code, `workflow ${operation} is not supported by the ${provider} provider.`)
  }
  if (code === "WORKFLOW_DEFINITION_NOT_FOUND") {
    return failure(404, code, "Workflow definition was not found.")
  }
  if (code === "VERCEL_WORKFLOW_SDK_LOAD_FAILED" || code === "WORKFLOW_NATIVE_ENTRY_INVALID" || code === "WORKFLOW_NATIVE_ENTRY_REQUIRED") {
    return failure(501, code, `workflow ${operation} needs a native Vercel Workflow run, which the local dev runtime does not start.`)
  }
  const message = error instanceof Error ? error.message : String(error)
  return failure(500, code || "WORKFLOW_DEV_FAILED", redactMessage(message || "Workflow dev request failed."))
}

/**
 * Creates the request handler behind the Workflow dev endpoint.
 *
 * The handler checks local support before it calls the runtime, remembers the
 * Workflow name of each run that it starts, and redacts credentials in run
 * data and error messages.
 */
export function createWorkflowDevHandler(options: WorkflowDevHandlerOptions): WorkflowDevHandler {
  const startedRuns = new Map<string, string>()

  function rememberRun(id: string, workflow: string): void {
    startedRuns.delete(id)
    startedRuns.set(id, workflow)
    if (startedRuns.size > maxRememberedRuns) {
      const oldest = startedRuns.keys().next().value
      if (oldest !== undefined) startedRuns.delete(oldest)
    }
  }

  return {
    discover() {
      const state = options.state()
      return {
        ...(state.error ? { error: state.error } : {}),
        operations: resolveWorkflowDevSupport(state.provider, state.error),
        provider: state.provider,
        root: state.root,
        workflows: state.workflows,
      }
    },
    async execute(body) {
      const request = parseRequest(body)
      if (!request) return failure(400, "WORKFLOW_DEV_INVALID_REQUEST", "Malformed Workflow Dev request.")
      const state = options.state()
      const support = resolveWorkflowDevSupport(state.provider, state.error)[request.operation]
      if (!support.supported || !state.provider) {
        return failure(state.provider ? 501 : 409, "WORKFLOW_DEV_UNSUPPORTED", unsupportedMessage(request.operation, state.provider, support.note))
      }
      const provider = state.provider

      try {
        if (request.operation === "start") {
          if (!state.workflows.includes(request.workflow)) {
            const available = state.workflows.length ? ` Available Workflows: ${state.workflows.join(", ")}.` : " No Workflow Definitions were discovered."
            return failure(404, "WORKFLOW_DEFINITION_NOT_FOUND", `Unknown Workflow: ${request.workflow}.${available}`)
          }
          const run = await (await options.loadRuntime()).runWorkflow(request.workflow, request.input)
          rememberRun(run.id, request.workflow)
          return { body: { run: await toWorkflowDevRunView(run, request.workflow) }, status: 200 }
        }
        if (request.operation === "resume") {
          const signal = await (await options.loadRuntime()).resumeWorkflowSignal(request.token, request.payload)
          return { body: { signal: { id: signal.id, provider: signal.provider } }, status: 200 }
        }
        const workflow = request.workflow ?? startedRuns.get(request.runId)
        if (!workflow) {
          return failure(400, "WORKFLOW_DEV_RUN_UNKNOWN", `Run ${request.runId} was not started through this Vite Development Server. Pass --workflow <name>.`)
        }
        const runtime = await options.loadRuntime()
        const run = request.operation === "get"
          ? await runtime.getWorkflowRun(workflow, request.runId)
          : await runtime.cancelWorkflow(workflow, request.runId)
        return { body: { run: await toWorkflowDevRunView(run, workflow) }, status: 200 }
      }
      catch (error) {
        return runtimeFailure(request.operation, provider, error)
      }
    },
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > maxRequestBytes) throw new RangeError("Workflow Dev request is too large.")
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

/**
 * Registers the guarded Workflow dev endpoint on a Vite Development Server.
 *
 * `GET` returns {@link WorkflowDevDiscovery}. `POST` runs one
 * {@link WorkflowDevRequest}. Requests without the guard header, from another
 * origin, or with a non-JSON `POST` body are rejected before the handler runs.
 */
export function registerWorkflowDevEndpoint(server: ViteHubDevEndpointServer, handler: WorkflowDevHandler): void {
  registerViteHubDevEndpoint(server, {
    handle: (req, res) => {
      if (req.method === "GET") {
        try {
          writeJson(res, 200, handler.discover())
        }
        catch (error) {
          writeJson(res, 500, { error: { code: "WORKFLOW_DEV_FAILED", message: redactMessage(error instanceof Error ? error.message : String(error)) } })
        }
        return
      }
      void readJsonBody(req)
        .then(
          async body => await handler.execute(body),
          (error: unknown) => failure(error instanceof RangeError ? 413 : 400, "WORKFLOW_DEV_INVALID_REQUEST", error instanceof RangeError ? error.message : "Malformed Workflow Dev request."),
        )
        .then(result => writeJson(res, result.status, result.body))
        .catch((error: unknown) => writeJson(res, 500, { error: { code: "WORKFLOW_DEV_FAILED", message: redactMessage(error instanceof Error ? error.message : String(error)) } }))
    },
    header: workflowDevHeader,
    headerValue: workflowDevHeaderValue,
    label: "Workflow Dev",
    methods: ["GET", "POST"],
    route: workflowDevRoute,
  })
}
