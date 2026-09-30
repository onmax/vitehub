<script setup lang="ts">
import type { ConnectionActivity } from "@vite-hub/connections";
import { onMounted, ref } from "vue";

import {
  connectionActivityListSchema,
  requestConnectionsManagement,
} from "../client/connections-management";
import { encodeAgentRouteParam } from "../console-route";

const pageSize = 50;
const props = defineProps<{ endpoint: string; name: string }>();
const events = ref<ConnectionActivity[]>([]);
const busy = ref(false);
const error = ref("");
const more = ref(false);
async function load(append = false) {
  busy.value = true;
  error.value = "";
  try {
    const result = await requestConnectionsManagement(
      props.endpoint,
      "activity",
      connectionActivityListSchema,
      {
        limit: pageSize,
        name: props.name,
        ...(append && events.value.length ? { before: events.value.at(-1)?.id } : {}),
      },
    );
    events.value = append ? [...events.value, ...result.events] : result.events;
    more.value = result.events.length === pageSize;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not load activity.";
  } finally {
    busy.value = false;
  }
}
function title(event: ConnectionActivity) {
  if (event.action !== "call") return event.action;
  return event.operation ?? "call";
}
onMounted(() => load());
</script>
<template>
  <div class="space-y-4">
    <div class="flex items-start justify-between gap-3">
      <p class="text-xs text-muted">
        Agent calls, writes, denials, failures, and account changes. Activity has no request or
        response bodies.
      </p>
      <UButton label="Refresh" color="neutral" variant="ghost" :loading="busy" @click="load()" />
    </div>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="!events.length && !busy && !error" class="text-sm text-muted">No recorded activity.</p>
    <ol role="list" class="divide-y divide-default">
      <li v-for="event in events" :key="event.id" class="space-y-1 py-3 text-xs">
        <div class="flex flex-wrap justify-between gap-2">
          <span class="break-all text-highlighted"
            >{{ title(event)
            }}<template v-if="event.effect"> · {{ event.effect }}</template></span
          ><span
            :class="
              event.outcome === 'failed' || event.outcome === 'denied'
                ? 'text-error'
                : event.outcome === 'approval-required'
                  ? 'text-warning'
                  : 'text-muted'
            "
            >{{ event.outcome
            }}<template v-if="event.status !== undefined"> · {{ event.status }}</template></span
          >
        </div>
        <p class="break-all text-muted">
          {{ event.actor.kind }} · {{ event.actor.id
          }}<template v-if="event.tool"> · tool {{ event.tool }}</template>
        </p>
        <p class="text-muted tabular-nums">
          <time :datetime="event.timestamp">{{ new Date(event.timestamp).toLocaleString() }}</time
          ><template v-if="event.durationMs !== undefined"> · {{ event.durationMs }} ms</template>
        </p>
        <p v-if="event.target" class="break-all font-mono text-muted">{{ event.target }}</p>
        <p v-if="event.error" class="break-words text-error">{{ event.error }}</p>
        <p v-if="event.traceId" class="break-all font-mono text-muted">Trace {{ event.traceId }}</p>
        <p v-if="event.invocationId" class="break-all font-mono text-muted">
          Invocation
          <RouterLink
            v-if="event.actor.kind === 'agent'"
            class="underline hover:text-highlighted"
            :to="{
              name: 'vitehub-console-invocation',
              params: { agent: encodeAgentRouteParam(event.actor.id), invocation: event.invocationId },
            }"
            >{{ event.invocationId }}</RouterLink
          ><template v-else>{{ event.invocationId }}</template>
        </p>
      </li>
    </ol>
    <UButton
      v-if="more"
      label="Load older activity"
      color="neutral"
      variant="outline"
      :loading="busy"
      @click="load(true)"
    />
  </div>
</template>
