<script setup lang="ts">
import type { ConnectionAccessRule, ConnectionSummary } from "@vite-hub/connections";
import { computed, ref, watch } from "vue";

import {
  connectionResultSchema,
  connectionStartSchema,
  requestConnectionsManagement,
} from "../client/connections-management";
import ConsoleOAuthConnectionActivity from "./console-oauth-connection-activity.vue";

const props = defineProps<{ admin: boolean; connection: ConnectionSummary; endpoint: string }>();
const emit = defineEmits<{ update: [connection: ConnectionSummary] }>();
const ruleKinds = ["allow", "approve", "deny"] as const;
const tab = ref("connection");
const busy = ref(false);
const confirmDisconnect = ref(false);
const error = ref("");
const notice = ref("");
const key = ref("");
watch(
  () => props.connection.name,
  () => {
    tab.value = "connection";
    confirmDisconnect.value = false;
    error.value = "";
    notice.value = "";
    key.value = "";
  },
);
const apiKey = computed(() => props.connection.kind === "api-key");
const connected = computed(
  () => props.connection.status === "active" || props.connection.status === "error",
);
const rules = computed(() => {
  const access = props.connection.access;
  const entries: Array<{ actor: string; rule: ConnectionAccessRule }> = [];
  if (access.server) entries.push({ actor: "Server code", rule: access.server });
  for (const [route, rule] of Object.entries(access.routes ?? {}))
    entries.push({ actor: `Route ${route}`, rule });
  for (const [agent, rule] of Object.entries(access.agents ?? {}))
    entries.push({ actor: `Agent ${agent}`, rule });
  return entries;
});
async function run(action: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not complete the request.";
  } finally {
    busy.value = false;
  }
}
function connect() {
  return run(async () => {
    const result = await requestConnectionsManagement(
      props.endpoint,
      "start",
      connectionStartSchema,
      { name: props.connection.name },
    );
    // The provider returns to /_vitehub/connections after consent.
    window.location.assign(result.url);
  });
}
function refresh() {
  return run(async () => {
    const result = await requestConnectionsManagement(
      props.endpoint,
      "refresh",
      connectionResultSchema,
      { name: props.connection.name },
    );
    emit("update", result.connection);
    notice.value = "Access token refreshed.";
  });
}
function setKey() {
  if (!key.value) return;
  return run(async () => {
    const result = await requestConnectionsManagement(
      props.endpoint,
      "set-key",
      connectionResultSchema,
      { key: key.value, name: props.connection.name },
    );
    key.value = "";
    emit("update", result.connection);
    notice.value = "Key saved. The next request uses it.";
  });
}
function disconnect() {
  if (!confirmDisconnect.value) {
    confirmDisconnect.value = true;
    return;
  }
  return run(async () => {
    confirmDisconnect.value = false;
    const result = await requestConnectionsManagement(
      props.endpoint,
      "disconnect",
      connectionResultSchema,
      { name: props.connection.name },
    );
    emit("update", result.connection);
    notice.value = apiKey.value
      ? "Disconnected. ViteHub deleted the key."
      : "Disconnected. ViteHub deleted the grant.";
  });
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex gap-2" aria-label="Connection views">
      <UButton
        v-for="item in [
          { value: 'connection', label: 'Connection' },
          { value: 'access', label: 'Access' },
          { value: 'activity', label: 'Activity' },
        ]"
        :key="item.value"
        :label="item.label"
        color="neutral"
        :variant="tab === item.value ? 'soft' : 'ghost'"
        :aria-pressed="tab === item.value"
        @click="tab = item.value"
      />
    </div>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
    <template v-if="tab === 'connection'">
      <p v-if="connection.description" class="text-sm text-muted">{{ connection.description }}</p>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-4 text-sm">
        <dt class="text-muted">Provider</dt>
        <dd class="break-words text-highlighted">{{ connection.provider }}</dd>
        <dt class="text-muted">Status</dt>
        <dd>
          {{
            connection.status === "active"
              ? "Connected"
              : connection.status === "needs-reconnect"
                ? "Reconnect required"
                : connection.status === "error"
                  ? "Error"
                  : "Not connected"
          }}
        </dd>
        <dt class="text-muted">API origins</dt>
        <dd>
          <ul role="list" class="space-y-1">
            <li
              v-for="origin in connection.origins"
              :key="origin"
              class="break-all font-mono text-xs"
            >
              {{ origin }}
            </li>
          </ul>
        </dd>
        <dt class="text-muted">Account</dt>
        <dd class="break-all">{{ connection.account ?? "None" }}</dd>
        <template v-if="connection.connectedAt">
          <dt class="text-muted">Connected</dt>
          <dd class="tabular-nums">{{ new Date(connection.connectedAt).toLocaleString() }}</dd>
        </template>
        <template v-if="connection.expiresAt">
          <dt class="text-muted">Token expires</dt>
          <dd class="tabular-nums">{{ new Date(connection.expiresAt).toLocaleString() }}</dd>
        </template>
        <template v-if="connection.header">
          <dt class="text-muted">Key header</dt>
          <dd class="break-all font-mono text-xs">{{ connection.header }}</dd>
        </template>
        <template v-if="connection.lastError">
          <dt class="text-muted">Last error</dt>
          <dd class="break-words text-error">{{ connection.lastError }}</dd>
        </template>
        <template v-if="!apiKey">
          <dt class="text-muted">Scopes</dt>
          <dd>
            <ul v-if="connection.scopes.length" role="list" class="space-y-1">
              <li
                v-for="scope in connection.scopes"
                :key="scope"
                class="break-all font-mono text-xs"
              >
                {{ scope }}
              </li>
            </ul>
            <span v-else class="text-muted">None</span>
          </dd>
        </template>
      </dl>
      <form
        v-if="admin && apiKey"
        class="space-y-3 border-t border-default pt-5"
        @submit.prevent="setKey"
      >
        <UFormField
          :label="connection.status === 'disconnected' ? 'Set key' : 'Replace key'"
          name="key"
          help="ViteHub seals the key and never shows it again."
        >
          <UInput
            v-model="key"
            type="password"
            autocomplete="new-password"
            class="w-full"
            :disabled="busy"
          />
        </UFormField>
        <div class="flex flex-wrap gap-2">
          <UButton type="submit" label="Save key" :loading="busy" :disabled="!key" />
          <UButton
            v-if="connection.status !== 'disconnected'"
            :label="confirmDisconnect ? 'Confirm disconnect' : 'Disconnect'"
            color="error"
            :variant="confirmDisconnect ? 'solid' : 'ghost'"
            :disabled="busy"
            @click="disconnect"
          />
        </div>
      </form>
      <div v-else-if="admin" class="flex flex-wrap gap-2 border-t border-default pt-5">
        <UButton
          :label="connection.status === 'disconnected' ? 'Connect' : 'Reconnect'"
          :loading="busy"
          @click="connect"
        />
        <UButton
          v-if="connected"
          label="Refresh token"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="refresh"
        />
        <UButton
          v-if="connection.status !== 'disconnected'"
          :label="confirmDisconnect ? 'Confirm disconnect' : 'Disconnect'"
          color="error"
          :variant="confirmDisconnect ? 'solid' : 'ghost'"
          :disabled="busy"
          @click="disconnect"
        />
      </div>
      <p v-else class="text-sm text-muted">
        Connections are read-only in this Console. Set <code>console.manageConnections</code> to
        change them.
      </p>
    </template>
    <template v-else-if="tab === 'access'">
      <p class="text-xs text-muted">
        Access rules come from the Connection Definition. ViteHub checks deny, then approve, then
        allow. When no pattern matches, reads are allowed and writes are denied.
      </p>
      <p v-if="!rules.length" class="text-sm text-muted">No access rules. Default rules apply.</p>
      <ul role="list" class="divide-y divide-default">
        <li v-for="entry in rules" :key="entry.actor" class="space-y-1 py-3 text-xs">
          <p class="break-all text-highlighted">{{ entry.actor }}</p>
          <p v-for="kind in ruleKinds" :key="kind" class="break-all">
            <template v-if="entry.rule[kind]?.length"
              ><span class="mr-2 text-muted">{{ kind }}</span>
              <span class="font-mono">{{ entry.rule[kind]?.join(", ") }}</span></template
            >
          </p>
        </li>
      </ul>
    </template>
    <ConsoleOAuthConnectionActivity v-else :endpoint="endpoint" :name="connection.name" />
  </div>
</template>
