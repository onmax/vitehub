import { emailErrorDiagnostics } from "./error-diagnostics.ts"

import type { EmailDriver, EmailDriverSource } from "./types.ts"

function assertEmailDriver(value: unknown): asserts value is EmailDriver {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This boundary validates a provider object before reading its required driver fields.
  if (!value || typeof value !== "object") throw emailErrorDiagnostics.EMAIL_R0001({ message: "Email driver must be an object." })
  // SAFETY: The object check permits field inspection; the required name and send fields are validated below before use.
  const driver = value as Partial<EmailDriver>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The public driver contract requires a non-empty string name for delivery diagnostics.
  if (typeof driver.name !== "string" || driver.name.trim().length === 0) throw emailErrorDiagnostics.EMAIL_R0002({ message: "Email driver name must be a non-empty string." })
  if (typeof driver.send !== "function") throw emailErrorDiagnostics.EMAIL_R0003({ message: "Email driver send must be a function." })
}

function withInitialization(driver: EmailDriver): EmailDriver {
  let initialization: Promise<void> | undefined
  return {
    name: driver.name,
    initialize() {
      initialization ??= Promise.resolve().then(() => driver.initialize?.()).catch((error: unknown) => {
        initialization = undefined
        throw error
      })
      return initialization
    },
    send: (message, context) => driver.send(message, context),
  }
}

/**
 * Owns driver validation and initialization for clients and delivery adapters.
 * Objects share initialization, including concurrent sends, and retry after failure.
 * Factories create a fresh lifecycle on each resolution, including request-scoped drivers.
 */
export function createEmailDriverResolver(source: EmailDriverSource): () => Promise<EmailDriver> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The public source union accepts a driver object or a factory with a per-send lifecycle.
  if (typeof source !== "function") {
    assertEmailDriver(source)
    const driver = withInitialization(source)
    return async () => driver
  }
  return async () => {
    const driver = await source()
    assertEmailDriver(driver)
    return withInitialization(driver)
  }
}
