import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
interface PayloadSchema<T> {
  safeParse: (payload: unknown) => { success: boolean, data?: T, error?: unknown }
}

interface ParsePayloadSchema<T> {
  parse: (payload: unknown) => T
}

type PayloadValidator<T> =
  | PayloadSchema<T>
  | ParsePayloadSchema<T>
  | ((payload: unknown) => T | Promise<T>)

export async function readRequestPayload<T = unknown>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") || ""
  if (contentType.includes("application/json")) {
    return await request.json() as T
  }
  return await request.text() as T
}

export async function validatePayload<T>(payload: unknown, schema: PayloadValidator<T>): Promise<T> {
  if (typeof schema === "function") {
    return await schema(payload)
  }

  if (Object.hasOwn(schema, "safeParse") && typeof (schema as { safeParse?: unknown }).safeParse === "function") {
    const result = (schema as PayloadSchema<T>).safeParse(payload)
    if (!result.success) {
      throw result.error || workflowErrorDiagnostics.WORKFLOW_R0021({ message: "Invalid workflow payload." })
    }
    return result.data as T
  }

  if (Object.hasOwn(schema, "parse") && typeof (schema as { parse?: unknown }).parse === "function") {
    return (schema as ParsePayloadSchema<T>).parse(payload)
  }

  throw workflowErrorDiagnostics.WORKFLOW_R0022({ message: "Invalid workflow payload schema." })
}

export async function readValidatedPayload<T>(request: Request, schema: PayloadValidator<T>): Promise<T> {
  return await validatePayload<T>(await readRequestPayload(request), schema)
}
