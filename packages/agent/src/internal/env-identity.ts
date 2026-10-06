/** Identities are registered only while resolving an Agent Definition. */
const identities = new WeakMap<object, string>()

export function createAgentEnvIdentity<T extends { name: string }>(identity: T): Readonly<T> {
  const result = Object.freeze({ ...identity })
  identities.set(result, result.name)
  return result
}

/** Read-only proof for Env. Copies and caller-created objects have no identity. */
export function readAgentEnvIdentity(identity: object): string | undefined {
  return identities.get(identity)
}
