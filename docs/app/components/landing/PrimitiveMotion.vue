<script setup lang="ts">
const props = withDefaults(defineProps<{
  name: string;
  /** Run one pass. Remount the component to run it again. */
  play?: boolean;
  delay?: number;
}>(), {
  play: false,
  delay: 0,
});
</script>

<!--
  Each scene rests on the result of its primitive and plays the call that produces it.
  The first and last frames match, so a pass never ends on a jump and a replay never starts with one.
  The filled dot is the same call token in every scene.
  Resting shapes start at x=6, the viewBox edge, so each icon aligns with the tile text.
-->
<template>
  <svg
    viewBox="6 0 58 40"
    preserveAspectRatio="xMinYMid meet"
    class="primitive-motion size-full"
    :class="{ 'is-playing': props.play }"
    :style="{ '--scene-delay': `${props.delay}ms` }"
    aria-hidden="true"
  >
    <template v-if="name === 'workspace'">
      <rect x="6" y="6" width="7" height="6" rx="1" class="line" />
      <path d="M9.5 12v18M9.5 16H15M9.5 23H15M9.5 30H15" class="line" />
      <rect x="18" y="14.5" width="22" height="3" rx="1" class="soft" />
      <rect x="18" y="21.5" width="16" height="3" rx="1" class="soft" />
      <rect x="18" y="28.5" width="26" height="3" rx="1" class="soft a ws-file" />
      <circle cx="9.5" cy="12" r="2" class="token a ws-token" />
    </template>

    <template v-else-if="name === 'kv'">
      <rect x="6" y="9" width="10" height="6" rx="1.5" class="soft" />
      <rect x="6" y="17" width="10" height="6" rx="1.5" class="soft a kv-key" />
      <rect x="6" y="25" width="10" height="6" rx="1.5" class="soft" />
      <rect x="20" y="9" width="22" height="6" rx="1.5" class="soft" />
      <rect x="20" y="17" width="26" height="6" rx="1.5" class="soft a kv-value" />
      <rect x="20" y="25" width="16" height="6" rx="1.5" class="soft" />
      <circle cx="11" cy="20" r="2" class="token a kv-token" />
    </template>

    <template v-else-if="name === 'queue'">
      <path d="M6 20h40" class="line" />
      <rect x="46" y="13" width="12" height="14" rx="2" class="line" />
      <rect x="49" y="17" width="6" height="6" rx="1" class="soft a q-worker" />
      <g class="a q-belt">
        <circle cx="2" cy="20" r="3" class="job a q-in" />
        <circle cx="14" cy="20" r="3" class="job" />
        <circle cx="26" cy="20" r="3" class="job" />
        <circle cx="38" cy="20" r="3" class="job a q-out" />
      </g>
    </template>

    <template v-else-if="name === 'workflow'">
      <path d="M14 20h14M36 20h14" class="line" />
      <path d="M14 20h14" class="ink-line a wf-rail-1" />
      <path d="M36 20h14" class="ink-line a wf-rail-2" />
      <circle cx="10" cy="20" r="4" class="line" />
      <circle cx="32" cy="20" r="4" class="line" />
      <circle cx="54" cy="20" r="4" class="line" />
      <circle cx="10" cy="20" r="1.75" class="ink a wf-step-1" />
      <circle cx="32" cy="20" r="1.75" class="ink a wf-step-2" />
      <circle cx="54" cy="20" r="1.75" class="ink a wf-step-3" />
    </template>

    <template v-else-if="name === 'schedule'">
      <circle cx="19" cy="20" r="13" class="line" />
      <path d="M19 20l5 3" class="line" />
      <path d="M19 20V11" class="ink-line a sch-hand" />
      <circle cx="19" cy="20" r="1.75" class="ink" />
      <circle cx="19" cy="20" r="13" class="ink-line ghost a sch-ring" />
      <path d="M38 20h20" class="line" />
      <circle cx="41" cy="20" r="2" class="soft a sch-run" />
      <circle cx="49" cy="20" r="2" class="soft" />
      <circle cx="57" cy="20" r="2" class="soft" />
    </template>

    <template v-else-if="name === 'sandbox'">
      <rect x="6" y="6" width="28" height="28" rx="3" class="line dashed" />
      <path d="M34 9v22" class="ink-line ghost a sb-wall" />
      <rect x="16" y="16" width="8" height="8" rx="1.5" class="soft a sb-process" />
      <circle cx="24" cy="20" r="2" class="token a sb-token" />
      <rect x="44" y="14" width="12" height="12" rx="2" class="soft" />
    </template>

    <template v-else-if="name === 'database'">
      <rect x="6" y="6" width="40" height="28" rx="2" class="line" />
      <path d="M6 13h40M16 13v21" class="line" />
      <rect x="7" y="15" width="38" height="6" class="band a db-band" />
      <rect x="9" y="16.75" width="4" height="2.5" rx="1" class="soft" />
      <rect x="9" y="22.75" width="4" height="2.5" rx="1" class="soft" />
      <rect x="9" y="28.75" width="4" height="2.5" rx="1" class="soft" />
      <rect x="19" y="16.75" width="22" height="2.5" rx="1" class="soft" />
      <rect x="19" y="22.75" width="18" height="2.5" rx="1" class="soft a db-match" />
      <rect x="19" y="28.75" width="24" height="2.5" rx="1" class="soft" />
      <circle cx="54" cy="24" r="2" class="token a db-token" />
    </template>

    <template v-else-if="name === 'blob'">
      <path d="M6 34h46" class="line" />
      <g class="a blob-card">
        <rect x="20" y="10" width="18" height="22" rx="2" class="line" />
        <path d="m23.5 28 4.5-5.5 3 3 2.5-3 3 5.5" class="line" />
        <circle cx="33.5" cy="14.5" r="1.5" class="soft" />
      </g>
      <rect x="20" y="10" width="18" height="22" rx="2" class="ink-line ghost a blob-ghost" />
    </template>

    <template v-else-if="name === 'auth'">
      <path d="M10.5 18v-3.5a5.5 5.5 0 0 1 11 0V18" class="ink-line a auth-shackle" />
      <rect x="6" y="18" width="20" height="15" rx="2.5" class="line" />
      <circle cx="16" cy="24.5" r="1.75" class="ink" />
      <path d="M16 26v3" class="ink-line" />
      <rect x="36" y="22.5" width="14" height="6" rx="3" class="soft a auth-session" />
      <circle cx="32" cy="24.5" r="2" class="token a auth-token" />
    </template>

    <template v-else-if="name === 'env'">
      <rect x="6" y="10.5" width="10" height="3" rx="1" class="soft" />
      <rect x="6" y="18.5" width="10" height="3" rx="1" class="soft" />
      <rect x="6" y="26.5" width="10" height="3" rx="1" class="soft" />
      <rect x="20" y="10.5" width="20" height="3" rx="1" class="soft a env-value-1" />
      <rect x="20" y="18.5" width="14" height="3" rx="1" class="soft a env-value-2" />
      <rect x="20" y="26.5" width="24" height="3" rx="1" class="soft a env-value-3" />
      <path d="m47 12 2 2 4-4" class="ink-line check a env-check-1" />
      <path d="m47 20 2 2 4-4" class="ink-line check a env-check-2" />
      <path d="m47 28 2 2 4-4" class="ink-line check a env-check-3" />
    </template>

    <template v-else-if="name === 'source'">
      <path d="M6 6h14l6 6v22H6zM20 6v6h6" class="line" />
      <rect x="10" y="16" width="12" height="2" rx="1" class="soft" />
      <rect x="10" y="21" width="9" height="2" rx="1" class="soft" />
      <rect x="10" y="26" width="12" height="2" rx="1" class="soft" />
      <path d="M36 13h7l2.5 3H58v16H36z" class="line" />
      <g class="a src-mounted">
        <rect x="40" y="21" width="13" height="2" rx="1" class="soft" />
        <rect x="40" y="25.5" width="9" height="2" rx="1" class="soft" />
      </g>
      <rect x="9" y="14" width="14" height="15" rx="1.5" class="ink-line ghost a src-ghost" />
    </template>

    <template v-else-if="name === 'shell'">
      <rect x="6" y="6" width="52" height="28" rx="2.5" class="line" />
      <path d="m11 12.5 3 2.5-3 2.5" class="ink-line" />
      <rect x="17" y="13.5" width="20" height="3" rx="1" class="command a sh-command" />
      <rect x="38" y="12.5" width="2" height="5" class="ink a sh-cursor" />
      <rect x="11" y="22" width="32" height="2.5" rx="1" class="soft a sh-output-1" />
      <rect x="11" y="27" width="22" height="2.5" rx="1" class="soft a sh-output-2" />
    </template>
  </svg>
</template>

<style scoped>
.primitive-motion {
  --cycle: 1600ms;
  --ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  overflow: visible;
}

.line,
.ink-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.line {
  opacity: 0.55;
}
.dashed {
  stroke-dasharray: 2.5 3;
}
.soft,
.job,
.command,
.ink,
.token,
.band {
  fill: currentColor;
}
.soft {
  opacity: 0.35;
}
.job,
.command {
  opacity: 0.55;
}
.token,
.band,
.ghost,
.q-in {
  opacity: 0;
}
.check {
  stroke-dasharray: 9;
}

.a {
  animation-duration: var(--cycle);
  animation-delay: var(--scene-delay);
  animation-iteration-count: 1;
  animation-fill-mode: both;
  animation-timing-function: var(--ease-move);
}
/* Scenes rest on their result until the landing page asks them to play. */
.primitive-motion:not(.is-playing) .a {
  animation-play-state: paused;
}

/* Scale and rotate around the element's own box unless the scene sets a pivot. */
.kv-value,
.wf-rail-1,
.wf-rail-2,
.sh-command,
.ws-file {
  transform-box: fill-box;
  transform-origin: left center;
}
.q-worker,
.sch-ring {
  transform-box: fill-box;
  transform-origin: center;
}
.blob-card {
  transform-box: fill-box;
  transform-origin: 50% 100%;
}
.sch-hand {
  transform-box: fill-box;
  transform-origin: 50% 100%;
}

/* Workspace: the call walks the tree and writes the last file. */
.ws-token { animation-name: ws-token; }
.ws-file { animation-name: ws-file; }
@keyframes ws-token {
  0%, 8% { opacity: 0; transform: translate(0, 0); }
  14% { opacity: 1; transform: translate(0, 0); }
  44% { opacity: 1; transform: translate(0, 18px); }
  56% { opacity: 1; transform: translate(6px, 18px); }
  62%, 100% { opacity: 0; transform: translate(8px, 18px); }
}
@keyframes ws-file {
  0% { opacity: 0.35; transform: scaleX(1); }
  8% { opacity: 0; transform: scaleX(1); }
  9% { opacity: 0.35; transform: scaleX(0); }
  56% { transform: scaleX(0); animation-timing-function: var(--ease-out); }
  82%, 100% { opacity: 0.35; transform: scaleX(1); }
}

/* KV: the call reads one key and overwrites its value. */
.kv-token { animation-name: kv-token; }
.kv-key { animation-name: kv-key; }
.kv-value { animation-name: kv-value; }
@keyframes kv-token {
  0%, 18% { opacity: 0; transform: translateX(0); }
  26% { opacity: 1; transform: translateX(0); }
  45% { opacity: 1; transform: translateX(10px); }
  52%, 100% { opacity: 0; transform: translateX(12px); }
}
@keyframes kv-key {
  0%, 6% { opacity: 0.35; }
  18%, 28% { opacity: 1; }
  46%, 100% { opacity: 0.35; }
}
@keyframes kv-value {
  0%, 44% { opacity: 0.35; transform: scaleX(1); }
  50% { opacity: 1; transform: scaleX(0.15); animation-timing-function: var(--ease-out); }
  72% { opacity: 1; transform: scaleX(1); }
  100% { opacity: 0.35; transform: scaleX(1); }
}

/* Queue: jobs advance one slot and the worker takes the first one. */
.q-belt { animation-name: q-belt; }
.q-in { animation-name: q-in; }
.q-out { animation-name: q-out; }
.q-worker { animation-name: q-worker; }
/* The belt returns to its start on the last frame. The dots then sit where the moved dots were. */
@keyframes q-belt {
  0%, 15% { transform: translateX(0); }
  60%, 99.9% { transform: translateX(12px); }
  100% { transform: translateX(0); }
}
@keyframes q-in {
  0%, 15% { opacity: 0; }
  55%, 99.9% { opacity: 0.55; }
  100% { opacity: 0; }
}
@keyframes q-out {
  0%, 30% { opacity: 0.55; }
  58%, 99.9% { opacity: 0; }
  100% { opacity: 0.55; }
}
@keyframes q-worker {
  0%, 52% { opacity: 0.35; transform: scale(1); }
  62% { opacity: 1; transform: scale(1.25); }
  84% { opacity: 1; transform: scale(1); }
  100% { opacity: 0.35; transform: scale(1); }
}

/* Workflow: steps complete in order and the run waits at the middle step. */
.wf-step-1 { animation-name: wf-step-1; }
.wf-step-2 { animation-name: wf-step-2; }
.wf-step-3 { animation-name: wf-step-3; }
.wf-rail-1 { animation-name: wf-rail-1; }
.wf-rail-2 { animation-name: wf-rail-2; }
@keyframes wf-step-1 {
  0% { opacity: 1; }
  8% { opacity: 0; }
  16%, 100% { opacity: 1; }
}
@keyframes wf-rail-1 {
  0% { opacity: 1; transform: scaleX(1); }
  8% { opacity: 0; transform: scaleX(1); }
  9% { opacity: 1; transform: scaleX(0); }
  16% { transform: scaleX(0); }
  34%, 100% { opacity: 1; transform: scaleX(1); }
}
@keyframes wf-step-2 {
  0% { opacity: 1; }
  8%, 34% { opacity: 0; }
  38%, 60% { opacity: 0.35; }
  66%, 100% { opacity: 1; }
}
@keyframes wf-rail-2 {
  0% { opacity: 1; transform: scaleX(1); }
  8% { opacity: 0; transform: scaleX(1); }
  9% { opacity: 1; transform: scaleX(0); }
  66% { transform: scaleX(0); }
  86%, 100% { opacity: 1; transform: scaleX(1); }
}
@keyframes wf-step-3 {
  0% { opacity: 1; }
  8%, 86% { opacity: 0; }
  92%, 100% { opacity: 1; }
}

/* Schedule: the hand completes one turn and the next run fires. */
.sch-hand { animation-name: sch-hand; }
.sch-ring { animation-name: sch-ring; }
.sch-run { animation-name: sch-run; }
@keyframes sch-hand {
  0%, 6% { transform: rotate(0deg); }
  60%, 100% { transform: rotate(360deg); }
}
@keyframes sch-ring {
  0%, 58% { opacity: 0; transform: scale(1); }
  62% { opacity: 0.7; transform: scale(1); animation-timing-function: var(--ease-out); }
  86%, 100% { opacity: 0; transform: scale(1.35); }
}
@keyframes sch-run {
  0%, 60% { opacity: 0.35; }
  66%, 86% { opacity: 1; }
  100% { opacity: 0.35; }
}

/* Sandbox: a call from inside reaches the boundary and stays inside. */
.sb-process { animation-name: sb-process; }
.sb-token { animation-name: sb-token; }
.sb-wall { animation-name: sb-wall; }
@keyframes sb-process {
  0%, 10% { opacity: 0.35; }
  18%, 78% { opacity: 1; }
  100% { opacity: 0.35; }
}
@keyframes sb-token {
  0%, 16% { opacity: 0; transform: translateX(0); }
  20% { opacity: 1; transform: translateX(0); animation-timing-function: cubic-bezier(0.5, 0, 1, 1); }
  40% { opacity: 1; transform: translateX(8px); animation-timing-function: var(--ease-out); }
  56% { opacity: 0.6; transform: translateX(1px); }
  64%, 100% { opacity: 0; transform: translateX(0); }
}
@keyframes sb-wall {
  0%, 38% { opacity: 0; }
  42% { opacity: 1; }
  72%, 100% { opacity: 0; }
}

/* Database: the query enters, scans to the matching row, and returns it. */
.db-token { animation-name: db-token; }
.db-band { animation-name: db-band; }
.db-match { animation-name: db-match; }
@keyframes db-token {
  0% { opacity: 0; transform: translateX(0); }
  8% { opacity: 1; transform: translateX(0); }
  24% { opacity: 1; transform: translateX(-8px); }
  30%, 100% { opacity: 0; transform: translateX(-8px); }
}
@keyframes db-band {
  0%, 22% { opacity: 0; transform: translateY(0); }
  28% { opacity: 0.12; transform: translateY(0); }
  48%, 80% { opacity: 0.12; transform: translateY(6px); }
  92%, 100% { opacity: 0; transform: translateY(6px); }
}
@keyframes db-match {
  0%, 46% { opacity: 0.35; }
  54%, 80% { opacity: 1; }
  100% { opacity: 0.35; }
}

/* Blob: an upload drops into place and the stored file settles. */
.blob-ghost { animation-name: blob-ghost; }
.blob-card { animation-name: blob-card; }
@keyframes blob-ghost {
  0%, 8% { opacity: 0; transform: translateY(-16px); animation-timing-function: cubic-bezier(0.5, 0, 0.9, 0.6); }
  20% { opacity: 0.9; }
  50% { opacity: 0.9; transform: translateY(0); }
  60%, 100% { opacity: 0; transform: translateY(0); }
}
@keyframes blob-card {
  0%, 49% { transform: scaleY(1); }
  55% { transform: scaleY(0.92); animation-timing-function: var(--ease-out); }
  72%, 100% { transform: scaleY(1); }
}

/* Auth: a credential opens the lock and the session starts. */
.auth-token { animation-name: auth-token; }
.auth-shackle { animation-name: auth-shackle; }
.auth-session { animation-name: auth-session; }
@keyframes auth-token {
  0%, 8% { opacity: 0; transform: translateX(0); }
  14% { opacity: 1; transform: translateX(0); }
  40% { opacity: 1; transform: translateX(-14px); }
  46%, 100% { opacity: 0; transform: translateX(-16px); }
}
@keyframes auth-shackle {
  0%, 44% { transform: translateY(0); }
  54%, 76% { transform: translateY(-3px); }
  88%, 100% { transform: translateY(0); }
}
@keyframes auth-session {
  0%, 52% { opacity: 0.35; }
  60%, 84% { opacity: 1; }
  100% { opacity: 0.35; }
}

/* Env: each value is validated in order. */
.env-check-1 { animation-name: env-check-1; }
.env-check-2 { animation-name: env-check-2; }
.env-check-3 { animation-name: env-check-3; }
.env-value-1 { animation-name: env-value-1; }
.env-value-2 { animation-name: env-value-2; }
.env-value-3 { animation-name: env-value-3; }
@keyframes env-check-1 {
  0% { opacity: 1; stroke-dashoffset: 0; }
  8% { opacity: 0; stroke-dashoffset: 0; }
  9%, 26% { opacity: 1; stroke-dashoffset: 9; }
  38%, 100% { opacity: 1; stroke-dashoffset: 0; }
}
@keyframes env-check-2 {
  0% { opacity: 1; stroke-dashoffset: 0; }
  8% { opacity: 0; stroke-dashoffset: 0; }
  9%, 44% { opacity: 1; stroke-dashoffset: 9; }
  56%, 100% { opacity: 1; stroke-dashoffset: 0; }
}
@keyframes env-check-3 {
  0% { opacity: 1; stroke-dashoffset: 0; }
  8% { opacity: 0; stroke-dashoffset: 0; }
  9%, 62% { opacity: 1; stroke-dashoffset: 9; }
  74%, 100% { opacity: 1; stroke-dashoffset: 0; }
}
@keyframes env-value-1 {
  0%, 18% { opacity: 0.35; }
  26% { opacity: 0.9; }
  40%, 100% { opacity: 0.35; }
}
@keyframes env-value-2 {
  0%, 36% { opacity: 0.35; }
  44% { opacity: 0.9; }
  58%, 100% { opacity: 0.35; }
}
@keyframes env-value-3 {
  0%, 54% { opacity: 0.35; }
  62% { opacity: 0.9; }
  76%, 100% { opacity: 0.35; }
}

/* Source: read-only content is mounted into the Workspace folder. */
.src-ghost { animation-name: src-ghost; }
.src-mounted { animation-name: src-mounted; }
@keyframes src-ghost {
  0%, 10% { opacity: 0; transform: translateX(0); }
  18% { opacity: 0.9; transform: translateX(0); }
  54% { opacity: 0.9; transform: translateX(29px); }
  64%, 100% { opacity: 0; transform: translateX(29px); }
}
@keyframes src-mounted {
  0% { opacity: 1; }
  8%, 54% { opacity: 0; }
  66%, 100% { opacity: 1; }
}

/* Shell: the command is typed, then its output appears. */
.sh-command { animation-name: sh-command; }
.sh-cursor { animation-name: sh-cursor; }
.sh-output-1 { animation-name: sh-output-1; }
.sh-output-2 { animation-name: sh-output-2; }
@keyframes sh-command {
  0% { opacity: 0.55; transform: scaleX(1); }
  8% { opacity: 0; transform: scaleX(1); }
  9% { opacity: 0.55; transform: scaleX(0); animation-timing-function: steps(6, end); }
  46%, 100% { opacity: 0.55; transform: scaleX(1); }
}
@keyframes sh-cursor {
  0% { opacity: 1; transform: translateX(0); }
  8% { opacity: 0; transform: translateX(0); }
  9% { opacity: 1; transform: translateX(-21px); animation-timing-function: steps(6, end); }
  46%, 100% { opacity: 1; transform: translateX(0); }
}
@keyframes sh-output-1 {
  0% { opacity: 0.35; transform: translateY(0); }
  8%, 50% { opacity: 0; transform: translateY(2px); animation-timing-function: var(--ease-out); }
  62%, 100% { opacity: 0.35; transform: translateY(0); }
}
@keyframes sh-output-2 {
  0% { opacity: 0.35; transform: translateY(0); }
  8%, 58% { opacity: 0; transform: translateY(2px); animation-timing-function: var(--ease-out); }
  70%, 100% { opacity: 0.35; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .a {
    animation: none;
  }
}
</style>
