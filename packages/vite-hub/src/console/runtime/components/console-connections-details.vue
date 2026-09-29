<script setup lang="ts">
import type { ConnectionInspection } from "@vite-hub/connections";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  connectionConnectURL,
  connectionResultSchema,
  connectionStatusLabel,
  requestConnectionsManagement,
} from "../client/connections-management";
import ConsoleConnectionsActivity from "./console-connections-activity.vue";
import ConsoleConnectionsApprovals from "./console-connections-approvals.vue";

const props = defineProps<{ connection: ConnectionInspection; endpoint: string }>();
const emit = defineEmits<{ changed: [] }>();
const current = ref<ConnectionInspection>(props.connection);
watch(
  () => props.connection,
  (connection) => {
    current.value = connection;
  },
);
const tab = ref("details");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const revoking = ref(false);
const confirmation = ref("");
let authorizing = false;

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
async function inspect() {
  const result = await requestConnectionsManagement(props.endpoint, "inspect", connectionResultSchema, {
    name: props.connection.name,
  });
  current.value = result.connection;
}
function reload() {
  return run(async () => {
    await inspect();
    emit("changed");
  });
}
function onFocus() {
  if (!authorizing) return;
  authorizing = false;
  window.removeEventListener("focus", onFocus);
  void reload();
}
function connect() {
  // The provider flow ends on a page that asks the user to close its tab, so it opens in a new tab.
  window.open(connectionConnectURL(props.endpoint, props.connection.name), "_blank", "noopener");
  notice.value = "Finish the authorization in the new tab. This view reloads when you come back.";
  if (!authorizing) window.addEventListener("focus", onFocus);
  authorizing = true;
}
function revoke() {
  if (confirmation.value !== props.connection.name) return;
  return run(async () => {
    const result = await requestConnectionsManagement(props.endpoint, "revoke", connectionResultSchema, {
      name: props.connection.name,
    });
    current.value = result.connection;
    revoking.value = false;
    confirmation.value = "";
    notice.value = "Revoked. Calls through this Connection stop until you connect it again.";
    emit("changed");
  });
}
onMounted(() => run(inspect));
onBeforeUnmount(() => window.removeEventListener("focus", onFocus));
</script>

<template>
  <div class="space-y-5">
    <div class="flex gap-2" aria-label="Connection views">
      <UButton
        v-for="item in [
          { value: 'details', label: 'Details' },
          { value: 'activity', label: 'Activity' },
          { value: 'approvals', label: 'Approvals' },
        ]"
        :key="item.value"
        :label="item.label"
        color="neutral"
        :variant="tab === item.value ? 'soft' : 'ghost'"
        :aria-pressed="tab === item.value"
        @click="tab = item.value"
      />
    </div>
    <template v-if="tab === 'details'">
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-4 text-sm">
        <dt class="text-muted">Provider</dt>
        <dd class="break-words text-highlighted">{{ current.provider }}</dd>
        <dt class="text-muted">Status</dt>
        <dd :class="current.status === 'reauth_required' ? 'text-error' : undefined">
          {{ connectionStatusLabel(current.status) }}
        </dd>
        <dt class="text-muted">Account</dt>
        <dd class="break-all">
          {{ current.account?.email ?? current.account?.id ?? "None" }}
        </dd>
        <template v-if="current.connectedAt">
          <dt class="text-muted">Connected</dt>
          <dd>
            <time :datetime="current.connectedAt" class="tabular-nums">{{
              new Date(current.connectedAt).toLocaleString()
            }}</time>
          </dd>
        </template>
        <template v-if="current.refreshedAt">
          <dt class="text-muted">Refreshed</dt>
          <dd>
            <time :datetime="current.refreshedAt" class="tabular-nums">{{
              new Date(current.refreshedAt).toLocaleString()
            }}</time>
          </dd>
        </template>
        <dt class="text-muted">Granted scopes</dt>
        <dd class="break-all font-mono text-xs">
          {{ current.scopes.granted.join(" ") || "None" }}
        </dd>
        <dt class="text-muted">Missing scopes</dt>
        <dd
          :class="[
            'break-all font-mono text-xs',
            current.scopes.missing.length ? 'text-error' : undefined,
          ]"
        >
          {{ current.scopes.missing.join(" ") || "None" }}
        </dd>
      </dl>
      <div class="flex flex-wrap gap-2">
        <UButton
          :label="
            current.status === 'disconnected' || current.status === 'revoked'
              ? 'Connect'
              : 'Reconnect'
          "
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="connect"
        />
        <UButton
          v-if="current.status === 'connected' || current.status === 'reauth_required'"
          label="Revoke"
          color="error"
          variant="ghost"
          :disabled="busy"
          @click="revoking = !revoking"
        />
        <UButton label="Reload" color="neutral" variant="ghost" :loading="busy" @click="reload" />
      </div>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
      <form v-if="revoking" class="space-y-3" @submit.prevent="revoke">
        <UFormField
          :label="`Type ${current.name} to revoke this Connection`"
          name="confirmation"
          description="The stored token is deleted. Agents and server code lose access until you connect again."
        >
          <UInput v-model="confirmation" autocomplete="off" class="w-full" :disabled="busy" />
        </UFormField>
        <UButton
          type="submit"
          label="Revoke Connection"
          color="error"
          :loading="busy"
          :disabled="confirmation !== current.name"
        />
      </form>
      <section v-if="current.actions.length" class="space-y-2">
        <h3 class="text-sm text-muted">Allowed actions</h3>
        <ul role="list" class="divide-y divide-default">
          <li
            v-for="action in current.actions"
            :key="action.id"
            class="flex flex-wrap justify-between gap-2 py-2 text-xs"
          >
            <span class="break-all font-mono text-highlighted">{{ action.id }}</span
            ><span :class="action.highRisk ? 'text-error' : 'text-muted'">{{
              action.highRisk ? "High risk" : action.write ? "Write" : "Read"
            }}</span>
          </li>
        </ul>
      </section>
    </template>
    <ConsoleConnectionsActivity
      v-else-if="tab === 'activity'"
      :endpoint="endpoint"
      :name="current.name"
    />
    <ConsoleConnectionsApprovals
      v-else-if="tab === 'approvals'"
      :endpoint="endpoint"
      :name="current.name"
      @changed="emit('changed')"
    />
  </div>
</template>
