import { grantEnvAccess } from "./access.ts";
import type { EnvActor, EnvBridge, EnvGrantedAccessContext } from "../bridge.ts";

/**
 * Internal to `@vite-hub/connections`. Call it only after the Connection access policy allows the call.
 * The context works on one bridge, for one Connection token key and one permission.
 */
export function connectionEnvAccess(
  bridge: EnvBridge,
  input: {
    actor: EnvActor;
    name: string;
    permission: "activity" | "replace" | "use";
    traceId?: string;
    invocationId?: string;
  },
): EnvGrantedAccessContext {
  return grantEnvAccess(input, {
    bridge,
    key: `connection/${input.name}`,
    permissions: [input.permission],
  });
}
