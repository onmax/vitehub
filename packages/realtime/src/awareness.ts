import { isPlainObject } from "@vite-hub/internal/object"
import { Diagnostic } from "nostics"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import type { RealtimeIdentity } from "./presence.ts"
import { maxAwarenessClients, readAwarenessClientIds } from "./protocol.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

const maxRoomAwarenessBytes = 8 * 1024 * 1024

export function claimAwarenessClientIds<Peer extends object>(owners: Map<number, Peer>, peer: Peer, clients: number[]): number[] {
  for (const client of clients) {
    const owner = owners.get(client)
    if (owner && owner !== peer) throw new AwarenessOwnershipConflict()
  }
  const ownedClients = new Set(
    [...owners].filter(([, owner]) => owner === peer).map(([client]) => client),
  )
  for (const client of clients) ownedClients.add(client)
  if (ownedClients.size > maxAwarenessClients) {
    throw realtimeErrorDiagnostics.REALTIME_R0003({ message: "Peer owns too many awareness clients." })
  }
  const claimed = clients.filter(client => !owners.has(client))
  for (const client of clients) owners.set(client, peer)
  return claimed
}

export class AwarenessOwnershipConflict extends Diagnostic {
  constructor() {
    super({ code: "REALTIME_R0013", docs: "https://vitehub.dev/docs/reference/diagnostics", why: "Awareness client id is already owned by another peer." }, AwarenessOwnershipConflict)
    this.name = "AwarenessOwnershipConflict"
  }
}

export function bindAwarenessIdentity(update: Uint8Array, identity: RealtimeIdentity): Uint8Array {
  return awarenessProtocol.modifyAwarenessUpdate(update, (state: unknown) => {
    if (state === null) return null
    if (!isPlainObject(state)) throw realtimeErrorDiagnostics.REALTIME_R0004({ message: "Invalid awareness state." })
    return { ...state, user: identity }
  })
}

export function applyRealtimeAwarenessUpdate(
  awareness: awarenessProtocol.Awareness,
  update: Uint8Array,
  origin: unknown,
  maxStateBytes = maxRoomAwarenessBytes,
): void {
  const candidateDocument = new Y.Doc()
  const candidate = new awarenessProtocol.Awareness(candidateDocument)
  candidate.setLocalState(null)
  let stateBytes: number
  try {
    const currentClients = [...awareness.getStates().keys()]
    if (currentClients.length) {
      awarenessProtocol.applyAwarenessUpdate(candidate, awarenessProtocol.encodeAwarenessUpdate(awareness, currentClients), origin)
    }
    awarenessProtocol.applyAwarenessUpdate(candidate, update, origin)
    const candidateClients = [...candidate.getStates().keys()]
    stateBytes = candidateClients.length
      ? awarenessProtocol.encodeAwarenessUpdate(candidate, candidateClients).byteLength
      : 0
  }
  finally {
    candidate.destroy()
    candidateDocument.destroy()
  }
  if (stateBytes > maxStateBytes) throw realtimeErrorDiagnostics.REALTIME_R0006({ message: "Realtime awareness exceeds its 8 MiB room quota." })
  awarenessProtocol.applyAwarenessUpdate(awareness, update, origin)
}

export function compactRealtimeAwareness(awareness: awarenessProtocol.Awareness): awarenessProtocol.Awareness {
  const clients = [...awareness.getStates().keys()]
  const update = clients.length ? awarenessProtocol.encodeAwarenessUpdate(awareness, clients) : undefined
  const compacted = new awarenessProtocol.Awareness(awareness.doc)
  compacted.setLocalState(null)
  if (update) awarenessProtocol.applyAwarenessUpdate(compacted, update, "compaction")
  awareness.destroy()
  return compacted
}

/** Owns peer claims and commits them only after identity binding and quota checks succeed. */
export function createRealtimeAwarenessOwners<Peer extends object>(options: { maxStateBytes?: number } = {}) {
  const owners = new Map<number, Peer>()
  const peerClients = new WeakMap<Peer, Set<number>>()
  return {
    apply(awareness: awarenessProtocol.Awareness, peer: Peer, update: Uint8Array, identity?: RealtimeIdentity): number[] {
      const clients = readAwarenessClientIds(update)
      const claimed = claimAwarenessClientIds(owners, peer, clients)
      try {
        const secured = identity ? bindAwarenessIdentity(update, identity) : update
        applyRealtimeAwarenessUpdate(awareness, secured, peer, options.maxStateBytes)
        const ownedClients = peerClients.get(peer) || new Set<number>()
        for (const client of clients) ownedClients.add(client)
        peerClients.set(peer, ownedClients)
        return clients
      }
      catch (error) {
        for (const client of claimed) {
          if (owners.get(client) === peer) owners.delete(client)
        }
        throw error
      }
    },
    release(peer: Peer): number[] {
      const clients = [...peerClients.get(peer) || []]
      peerClients.delete(peer)
      for (const client of clients) {
        if (owners.get(client) === peer) owners.delete(client)
      }
      return clients
    },
  }
}
