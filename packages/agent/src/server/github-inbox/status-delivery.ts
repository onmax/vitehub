import * as v from "valibot";

export const statusOutboxPrefix = "status-outbox:v1:";
export const statusSentPrefix = "status-sent:v1:";
export const workerBlockerPrefix = "worker-blocker:v1:";
export const statusTargetKey = (snapshot: { repository: string; number: number }): string => `${snapshot.repository}#${snapshot.number}`;

export interface StatusDelivery {
  version: string;
  contentKey: string;
  repository: string;
  number: number;
  head: string;
  precedingHead?: string;
  generation: number;
  text: string;
  attempts: number;
  nextAt: number;
  lastError?: string;
  activity: {
    runId: string;
    status: "failed" | "completed" | "waiting";
    startedAt?: string;
    updatedAt: string;
    links: Array<{ label: string; url: string }>;
    tasks: never[];
    summary: string;
  };
}

export const statusDeliverySchema: v.GenericSchema<unknown, StatusDelivery> = v.object({
  version: v.string(), contentKey: v.string(), repository: v.string(), number: v.number(),
  head: v.string(), precedingHead: v.optional(v.string()), generation: v.number(), text: v.string(), attempts: v.number(), nextAt: v.number(),
  lastError: v.optional(v.string()),
  activity: v.object({
    runId: v.string(), status: v.picklist(["failed", "completed", "waiting"]), startedAt: v.optional(v.string()),
    updatedAt: v.string(), links: v.array(v.object({ label: v.string(), url: v.string() })),
    tasks: v.array(v.never()), summary: v.string(),
  }),
});
