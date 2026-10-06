import { createEnvAuthenticator } from "../src/auth.ts"

/** Create an administrator context through the same check that production uses. */
export async function adminContext(id = "owner") {
  const authenticate = createEnvAuthenticator({ getSession: async () => ({ user: { id } }), isAdmin: () => true })
  const context = await authenticate(new Request("https://example.com"))
  if (!context) throw new Error("Expected an administrator context.")
  return context
}

export function stringSchema() {
  return {
    safeParse(input: unknown) {
      return typeof input === "string" && input.length > 0
        ? { data: input, success: true as const }
        : { error: new Error("Expected non-empty string"), success: false as const }
    },
  }
}

export function booleanSchema() {
  return {
    safeParse(input: unknown) {
      if (input === "true" || input === true) {
        return { data: true, success: true as const }
      }
      if (input === "false" || input === false) {
        return { data: false, success: true as const }
      }
      return { error: new Error("Expected boolean"), success: false as const }
    },
  }
}
