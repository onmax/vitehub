import * as v from "valibot"

import { getConsoleAgentDefinition } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestJSON, consoleRequestURL } from "./request.ts"
import { invocationUsage } from "./usage.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentInvocationCancelResult, AgentInvocationSummary } from "@vite-hub/agent"
import type { TraceEventLogEntry } from "@vite-hub/runtime"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

/** Record actions that Console invoke access allows. */
interface ConsoleInvocationActions {
  cancel: { available: boolean }
}

interface ConsoleInvocationDetail {
  appendObservations?: boolean
  invocation: AgentInvocationSummary & { actions?: ConsoleInvocationActions, usage?: ReturnType<typeof invocationUsage> }
  observationCursor: string
  observations: readonly TraceEventLogEntry[]
}

function observationCursor(observations: readonly TraceEventLogEntry[], count = observations.length): string {
  let fnv = 2_166_136_261
  let djb = 5_381
  for (let index = 0; index < count; index++) {
    const serialized = JSON.stringify(observations[index])
    for (let offset = 0; offset <= serialized.length; offset++) {
      const code = offset === serialized.length ? 0 : serialized.charCodeAt(offset)
      fnv = Math.imul(fnv ^ code, 16_777_619)
      djb = Math.imul(djb, 33) ^ code
    }
  }
  return `${count.toString(36)}-${(fnv >>> 0).toString(36)}-${(djb >>> 0).toString(36)}`
}

const cancelActionSchema = v.strictObject({ action: v.literal("cancel") })
const activeStatuses: ReadonlySet<AgentInvocationSummary["status"]> = new Set(["pending", "running"])

function notFound(): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0054({ message: "Invocation not found" }), {
    statusCode: 404,
    statusMessage: "Invocation not found",
  })
}

function actionError(statusCode: number, statusMessage: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0046({ message: statusMessage }), { statusCode, statusMessage })
}

function requestedInvocationId(event: ConsoleRequestEvent): string {
  const pathId = consoleRequestURL(event).pathname.split("/").at(-1)
  return event.context?.params?.id ?? (pathId ? decodeURIComponent(pathId) : "")
}

// Console invoke access for the record's Agent allows these actions.
function invocationActions(invocation: AgentInvocationSummary): ConsoleInvocationActions | undefined {
  if (!invocation.agentName || !getConsoleAgentDefinition(invocation.agentName)) return
  return { cancel: { available: activeStatuses.has(invocation.status) } }
}

/** Cancel one pending or running invocation after the Console checks invoke access for its Agent. */
export async function cancelConsoleInvocation(event: ConsoleRequestEvent): Promise<AgentInvocationCancelResult> {
  assertConsoleRequest(event, ["POST"])
  const id = requestedInvocationId(event)
  let body: unknown
  try {
    body = await consoleRequestJSON(event)
  }
  catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error
    throw actionError(400, "Malformed invocation action.")
  }
  if (!v.safeParse(cancelActionSchema, body).success) throw actionError(400, "Unsupported invocation action.")
  const invocations = getConsoleInvocations()
  const summary = await invocations.getSummary(id)
  if (!summary) throw notFound()
  if (!summary.agentName || !getConsoleAgentDefinition(summary.agentName)) throw actionError(403, "Cancelling this invocation requires Console invoke access for its Agent.")
  const result = await invocations.cancel(id)
  if (result.outcome === "not-found") throw notFound()
  if (result.outcome === "terminal") throw actionError(409, result.notEnforcedBy
    ? `Invocation journal is ${result.status ?? "terminal"}; local abort requested, not enforced by ${result.notEnforcedBy}.`
    : "Only pending or running invocations can be cancelled.")
  if (result.outcome === "unavailable") throw actionError(503, "The invocation journal did not record the cancel request.")
  return result
}

/** Read one invocation with its observations and the actions that Console access allows. */
export async function getConsoleInvocationDetail(event: ConsoleRequestEvent): Promise<ConsoleInvocationDetail> {
  assertConsoleRequest(event, ["GET"])
  const invocation = await getConsoleInvocations().get(requestedInvocationId(event))
  if (!invocation) throw notFound()
  const { observations, ...summary } = invocation
  const usage = invocationUsage(invocation)
  const actions = invocationActions(summary)
  const requestURL = consoleRequestURL(event)
  const countValue = requestURL.searchParams.get("observationCount")
  const requestedCursor = requestURL.searchParams.get("observationCursor")
  const observationCount = countValue === null ? undefined : Number(countValue)
  const canAppend = invocation.observationsTruncated !== true
    && requestedCursor !== null
    && observationCount !== undefined
    && Number.isSafeInteger(observationCount)
    && observationCount >= 0
    && observationCount <= observations.length
    && requestedCursor === observationCursor(observations, observationCount)
  const detail: ConsoleInvocationDetail = {
    invocation: { ...summary, ...(actions ? { actions } : {}), ...(usage ? { usage } : {}) },
    observationCursor: observationCursor(observations),
    observations: canAppend
      ? observations.slice(observationCount)
      : observations,
  }
  if (canAppend) detail.appendObservations = true
  return detail
}

// The devframe `invocation` operation reads one record with GET and changes it with POST.
const invocationHandler = async (event: ConsoleRequestEvent): Promise<ConsoleInvocationDetail | AgentInvocationCancelResult> => {
  assertConsoleRequest(event, ["GET", "POST"])
  return (event.method ?? event.req?.method ?? event.node?.req?.method) === "POST"
    ? await cancelConsoleInvocation(event)
    : await getConsoleInvocationDetail(event)
}

export default invocationHandler
