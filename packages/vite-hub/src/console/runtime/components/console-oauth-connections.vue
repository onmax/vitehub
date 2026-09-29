<script setup lang="ts">
import type { TableColumn, TableRow } from "@nuxt/ui";
import type { ConnectionSummary } from "@vite-hub/connections";
import * as v from "valibot";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  connectionsListSchema,
  requestConnectionsManagement,
} from "../client/connections-management";
import { rememberConsoleSection } from "../sections";
import ConsoleBrand from "./console-brand.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsolePrimitiveSwitcher from "./console-primitive-switcher.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleOAuthConnectionDetails from "./console-oauth-connection-details.vue";

const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  managementBase: string;
  searchBase: string;
  sectionsBase: string;
}>();
const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const connections = ref<readonly ConnectionSummary[]>([]);
const admin = ref(false);
const search = ref("");
const selectedName = ref<string>();
const loading = ref(true);
const error = ref("");
const notice = ref("");
let active = 0;
const selected = computed(() =>
  connections.value.find((connection) => connection.name === selectedName.value),
);
const detailOpen = computed({
  get: () => Boolean(selected.value),
  set: (open: boolean) => {
    if (!open) selectedName.value = undefined;
  },
});
const rows = computed(() =>
  connections.value.filter((connection) =>
    `${connection.name} ${connection.provider} ${connection.account ?? ""}`
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
const columns: TableColumn<ConnectionSummary>[] = [
  { accessorKey: "name", header: "Connection" },
  { accessorKey: "provider", header: "Provider" },
  { id: "account", header: "Account" },
  { id: "status", header: "Status" },
  { id: "expiresAt", header: "Token expires" },
];
const statusLabels: Record<ConnectionSummary["status"], string> = {
  active: "Connected",
  disconnected: "Not connected",
  error: "Error",
  "needs-reconnect": "Reconnect required",
};
const statusColors: Record<ConnectionSummary["status"], "error" | "neutral" | "success" | "warning"> = {
  active: "success",
  disconnected: "neutral",
  error: "error",
  "needs-reconnect": "warning",
};
function selectRow(_event: Event, row: TableRow<ConnectionSummary>) {
  selectedName.value = row.original.name;
}
function update(connection: ConnectionSummary) {
  connections.value = connections.value.map((item) =>
    item.name === connection.name ? connection : item,
  );
}
async function refresh() {
  const request = ++active;
  loading.value = true;
  error.value = "";
  try {
    const result = await requestConnectionsManagement(
      props.managementBase,
      "list",
      connectionsListSchema,
    );
    if (request !== active) return;
    connections.value = result.connections;
    admin.value = result.admin;
  } catch (cause) {
    if (request === active)
      error.value = cause instanceof Error ? cause.message : "Could not load Connections.";
  } finally {
    if (request === active) loading.value = false;
  }
}
const callbackQuerySchema = v.object({
  connection: v.string(),
  result: v.picklist(["connected", "failed"]),
});
// The OAuth callback returns to this page with ?connection=<name>&result=connected|failed.
function readCallbackResult() {
  const query = v.safeParse(callbackQuerySchema, route.query);
  if (!query.success) return;
  const { connection: name, result } = query.output;
  selectedName.value = name;
  notice.value =
    result === "connected"
      ? `Connected ${name}.`
      : `Could not connect ${name}. Check the provider client and try again.`;
  void router.replace({ query: {} });
}
onMounted(() => {
  rememberConsoleSection("connections");
  readCallbackResult();
  void refresh();
});
onBeforeUnmount(() => {
  active++;
});
</script>

<template>
  <ConsoleFrame>
    <UDashboardSidebar
      id="console-navigation"
      v-model:open="sidebarOpen"
      :default-size="16"
      :min-size="13"
      :max-size="26"
      :menu="{ title: 'Connections', description: 'Provider accounts.' }"
      :ui="{
        body: 'gap-0 overflow-hidden p-0',
        footer: 'h-11 shrink-0 border-t border-default px-2 py-1.5',
      }"
      resizable
    >
      <template #header="{ collapsed }"
        ><ConsoleBrand :collapsed="collapsed" :sections-base="sectionsBase"
      /></template>
      <template #default="{ collapsed }">
        <div class="flex shrink-0 items-center gap-1 px-[0.875rem] pb-2 pt-1">
          <UDashboardSearchButton
            :collapsed="collapsed"
            block
            class="vitehub-console__search min-w-0 flex-1 rounded-md border border-default bg-transparent px-2 ring-0 hover:bg-elevated/60"
            label="Search console"
          />
        </div>
      </template>
      <template #footer="{ collapsed }"
        ><ConsolePrimitiveSwitcher
          active="connections"
          :collapsed="collapsed"
          :sections-base="sectionsBase"
      /></template>
    </UDashboardSidebar>
    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />
    <UDashboardPanel id="connections" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <template #header>
        <UDashboardNavbar title="Connections" :toggle="{ 'aria-label': 'Open sidebar' }">
          <template #right>
            <UTooltip text="Refresh Connections"
              ><UButton
                aria-label="Refresh Connections"
                color="neutral"
                icon="i-ph-arrows-clockwise-light"
                size="xs"
                variant="ghost"
                :disabled="loading"
                @click="refresh"
            /></UTooltip>
          </template>
        </UDashboardNavbar>
        <div class="flex flex-wrap items-center gap-2 border-b border-default px-4 py-2">
          <UInput
            v-model="search"
            aria-label="Search Connections"
            placeholder="Search Connections…"
            icon="i-ph-magnifying-glass-light"
            variant="none"
            class="min-w-40 flex-1"
          />
        </div>
      </template>
      <template #body>
        <main class="min-h-0 flex-1 overflow-auto">
          <p v-if="notice" role="status" class="border-b border-default px-4 py-2 text-sm text-muted">
            {{ notice }}
          </p>
          <div v-if="error" role="alert" class="flex items-center gap-3 p-4 text-sm">
            <span>{{ error }}</span
            ><UButton label="Try again" color="neutral" variant="ghost" @click="refresh" />
          </div>
          <p v-else-if="loading && !connections.length" role="status" class="p-4 text-sm text-muted">
            Loading Connections…
          </p>
          <UTable
            v-else
            :data="rows"
            :columns="columns"
            :on-select="selectRow"
            :empty="
              connections.length
                ? 'No matching Connections.'
                : 'No Connections defined. Add a file in server/connections/.'
            "
            :ui="{
              tr: 'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary',
            }"
          >
            <template #name-cell="{ row }"
              ><span class="font-mono text-xs text-highlighted">{{
                row.original.name
              }}</span></template
            >
            <template #provider-cell="{ row }"
              ><span class="text-xs text-muted">{{ row.original.provider }}</span></template
            >
            <template #account-cell="{ row }"
              ><span class="text-xs text-muted">{{ row.original.account ?? "None" }}</span></template
            >
            <template #status-cell="{ row }"
              ><UBadge
                :color="statusColors[row.original.status]"
                :label="statusLabels[row.original.status]"
                size="sm"
                variant="subtle"
            /></template>
            <template #expiresAt-cell="{ row }"
              ><time
                v-if="row.original.expiresAt"
                :datetime="row.original.expiresAt"
                class="text-xs text-muted tabular-nums"
                >{{ new Date(row.original.expiresAt).toLocaleString() }}</time
              ><span v-else class="text-xs text-muted">None</span></template
            >
          </UTable>
        </main>
      </template>
    </UDashboardPanel>
    <USlideover
      v-model:open="detailOpen"
      :title="selected?.name || 'Connection'"
      description="Connection details"
      :ui="{ description: 'sr-only' }"
    >
      <template #body
        ><ConsoleOAuthConnectionDetails
          v-if="selected"
          :admin="admin"
          :connection="selected"
          :endpoint="managementBase"
          @update="update"
      /></template>
    </USlideover>
  </ConsoleFrame>
</template>
