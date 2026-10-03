import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

export function isCallableMember<TValue>(value: TValue): value is Extract<TValue, CallableFunction> {
  return hasRuntimeType(value, "function")
}

export function isRuntimeRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && hasRuntimeType(value, "object")
}
