import { defineGrant } from "@vite-hub/runtime/internal/grant";

import { envBridgeError } from "../bridge-error.ts";
import type { EnvAccessContext, EnvActor, EnvBridge, EnvGrantedAccessContext, EnvPermission } from "../bridge.ts";

/** Marks the type of contexts that Env creates. The bridge trusts only the `envAccess` grant registry, not this marker. */
export const envAccessGrant: unique symbol = Symbol("vitehub.env.access-grant");

export type EnvKeyPermission = EnvPermission | "activity";
export type EnvAuthority =
  | { readonly admin: true }
  | { readonly bridge: EnvBridge; readonly key: string; readonly permissions: readonly EnvKeyPermission[] };

const envAccess = defineGrant("vitehub.env.access", (authority: EnvAuthority): EnvAuthority =>
  "admin" in authority
    ? Object.freeze({ admin: true })
    : Object.freeze({ bridge: authority.bridge, key: authority.key, permissions: Object.freeze([...authority.permissions]) }));

/** Create a frozen context. Only Env modules call this after their own check. */
export function grantEnvAccess(
  attribution: { actor: EnvActor; traceId?: string; invocationId?: string },
  authority: EnvAuthority,
): EnvGrantedAccessContext {
  return envAccess.issue(authority, {
    [envAccessGrant]: true as const,
    actor: Object.freeze({ id: attribution.actor.id, kind: attribution.actor.kind }),
    ...("admin" in authority ? { admin: true as const } : {}),
    ...(attribution.traceId ? { traceId: attribution.traceId } : {}),
    ...(attribution.invocationId ? { invocationId: attribution.invocationId } : {}),
  });
}

/** Return the authority that Env recorded. A context that claims authority Env did not create fails closed. */
export function envAccessAuthority(context: EnvAccessContext): EnvAuthority | undefined {
  const authority = envAccess.check(context);
  if (authority) return authority;
  if (envAccessGrant in context || context.admin) throw envBridgeError("untrusted");
  return undefined;
}
