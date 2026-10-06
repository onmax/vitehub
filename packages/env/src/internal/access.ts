import { envBridgeError } from "../bridge-error.ts";
import type { EnvAccessContext, EnvActor, EnvBridge, EnvGrantedAccessContext, EnvPermission } from "../bridge.ts";

/** Marks the type of contexts that Env creates. The bridge trusts only `authorities`, not this marker. */
export const envAccessGrant: unique symbol = Symbol("vitehub.env.access-grant");

export type EnvKeyPermission = EnvPermission | "activity";
export type EnvAuthority =
  | { readonly admin: true }
  | { readonly bridge: EnvBridge; readonly key: string; readonly permissions: readonly EnvKeyPermission[] };

const authorities = new WeakMap<EnvAccessContext, EnvAuthority>();

/** Create a frozen, request-scoped context. Only Env modules call this after their own check. */
export function grantEnvAccess(
  attribution: { actor: EnvActor; traceId?: string; invocationId?: string },
  authority: EnvAuthority,
): EnvGrantedAccessContext {
  const context: EnvGrantedAccessContext = Object.freeze({
    [envAccessGrant]: true as const,
    actor: Object.freeze({ id: attribution.actor.id, kind: attribution.actor.kind }),
    ...("admin" in authority ? { admin: true as const } : {}),
    ...(attribution.traceId ? { traceId: attribution.traceId } : {}),
    ...(attribution.invocationId ? { invocationId: attribution.invocationId } : {}),
  });
  authorities.set(
    context,
    "admin" in authority
      ? Object.freeze({ admin: true })
      : Object.freeze({ bridge: authority.bridge, key: authority.key, permissions: Object.freeze([...authority.permissions]) }),
  );
  return context;
}

/** Return the authority that Env recorded. A context that claims authority Env did not create fails closed. */
export function envAccessAuthority(context: EnvAccessContext): EnvAuthority | undefined {
  const authority = authorities.get(context);
  if (authority) return authority;
  if (envAccessGrant in context || context.admin) throw envBridgeError("untrusted");
  return undefined;
}
