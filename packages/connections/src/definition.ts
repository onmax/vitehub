import type { ConnectionApiSelection, ConnectionDefinition } from "./types.ts"

/** Define a Connection. The file name under `server/connections/` is the Connection name. */
export function defineConnection<
  const TApis extends object,
  const TSelection extends ConnectionApiSelection<TApis> = ConnectionApiSelection<TApis>,
>(definition: ConnectionDefinition<TApis, TSelection>): ConnectionDefinition<TApis, TSelection> {
  return definition
}
