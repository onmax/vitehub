import { envBridgeError } from "../bridge-error.ts";
import type { EnvAccessContext, EnvAccessScope, EnvActor, EnvBridge, EnvPermission } from "../bridge.ts";

/** Marks the type of contexts that Env creates. The bridge trusts only `authorities`, not this marker. */
export const envAccessGrant: unique symbol = Symbol("vitehub.env.access-grant");

export type EnvKeyPermission = EnvPermission | "activity";
export type EnvAuthority =
  | { readonly kind: "admin" }
  /** The durable grants of the context actor, with an optional ceiling. A `bridge` limits the context to that bridge. */
  | { readonly kind: "actor"; readonly bridge?: EnvBridge; readonly scope?: EnvAccessScope }
  | { readonly kind: "key"; readonly bridge: EnvBridge; readonly key: string; readonly permissions: readonly EnvKeyPermission[] };
export interface EnvAttribution {
  traceId?: string;
  invocationId?: string;
}

const authorities = new WeakMap<object, EnvAuthority>();

export function envIdentifier(value: string): void {
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > 512 || /[\u0000-\u001f]/.test(value))
    throw envBridgeError("invalid");
}

export function validateEnvActor(actor: EnvActor): void {
  envIdentifier(actor.id);
  if (!["user", "agent", "service"].includes(actor.kind)) throw envBridgeError("invalid");
}

/** Create a frozen context. Only Env modules call this after their own check. */
export function grantEnvAccess(
  attribution: EnvAttribution & { actor: EnvActor },
  authority: EnvAuthority,
): EnvAccessContext {
  validateEnvActor(attribution.actor);
  const scope =
    authority.kind === "actor" && authority.scope
      ? Object.freeze(authority.scope.map((grant) => Object.freeze({ key: grant.key, permissions: Object.freeze([...grant.permissions]) })))
      : undefined;
  const context: EnvAccessContext = Object.freeze({
    [envAccessGrant]: true as const,
    actor: Object.freeze({ id: attribution.actor.id, kind: attribution.actor.kind }),
    ...(authority.kind === "admin" ? { admin: true as const } : {}),
    ...(scope ? { scope } : {}),
    ...(attribution.traceId ? { traceId: attribution.traceId } : {}),
    ...(attribution.invocationId ? { invocationId: attribution.invocationId } : {}),
  });
  authorities.set(
    context,
    authority.kind === "key"
      ? Object.freeze({ ...authority, permissions: Object.freeze([...authority.permissions]) })
      : Object.freeze({ ...authority, ...(scope ? { scope } : {}) }),
  );
  return context;
}

/** Return the authority that Env recorded. A context that Env did not create fails closed. */
export function envAccessAuthority(context: EnvAccessContext): EnvAuthority {
  const authority = authorities.get(context);
  if (!authority) throw envBridgeError("untrusted");
  return authority;
}
