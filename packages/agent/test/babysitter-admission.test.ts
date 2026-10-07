import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts";
import { describe, expect, it } from "vitest";
import { babysitterModelAdmission, createBabysitterAdmission, babysitterAdmissionDecision, babysitterBudgetWindows, readBabysitterAdmissionLimits } from "../src/presets/babysitter/admission.ts";

describe("Babysitter admission", () => {
  it("uses bounded defaults and accepts a healthy host", () => {
    const limits = readBabysitterAdmissionLimits({});
    expect(limits.hourlyInputTokens).toBe(15e6);
    expect(limits.dailyInputTokens).toBe(200e6);
    expect(babysitterAdmissionDecision({ windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp", freeTmpBytes: 64 * 2 ** 30 }, limits)).toEqual({ accepting: true });
  });

  it("parks model passes when temporary storage is low", () => {
    const limits = readBabysitterAdmissionLimits({});
    const result = babysitterAdmissionDecision({ windows: babysitterBudgetWindows(Date.now()), tmpDir: "/scratch", freeTmpBytes: 3 * 2 ** 30 }, limits);
    expect(result).toMatchObject({ accepting: false, hostOnly: true, reason: "tmp-space-low" });
  });

  it("pauses at the hourly budget until the next hour", () => {
    const now = new Date(2026, 9, 5, 19, 13).getTime();
    const limits = readBabysitterAdmissionLimits({ BABYSITTER_HOURLY_INPUT_TOKENS: "1" });
    const result = babysitterAdmissionDecision({ windows: babysitterBudgetWindows(now), tmpDir: "/tmp", hourlyInputTokens: 1 }, limits);
    expect(result).toMatchObject({ accepting: false, reason: "token-budget-hourly", retryAt: new Date(2026, 9, 5, 20).getTime() });
  });
});

it("reads paginated usage from the assigned journal", async () => {
  const store = createMemoryAgentInvocationStore();
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  for (let index = 0; index < 101; index++) {
    await store.create({ id: String(index), traceId: String(index), createdAt: timestamp, updatedAt: timestamp, status: "completed", observations: [
      { name: "usage", type: "run", sequence: 1, timestamp, attributes: { "usage.inputTokens": 2 } },
      { name: "usage", type: "run", sequence: 2, timestamp, attributes: { "usage.inputTokens": 3 } },
    ] });
  }
  const check = createBabysitterAdmission({ invocations: defineAgentInvocations({ store }), limits: readBabysitterAdmissionLimits({ BABYSITTER_MIN_FREE_TMP_MB: "0", BABYSITTER_HOURLY_INPUT_TOKENS: "300" }) });
  expect(await check(now)).toMatchObject({ accepting: false, reason: "token-budget-hourly", state: { hourlyInputTokens: 303, dailyInputTokens: 303 } });
});

it("gates recovery model work on host admission and the same-head progress budget", () => {
  const snapshot = { pr: { number: 1, head: { sha: "a" } }, progressBudget: { head: "a", exhausted: true, count: 3, limit: 3, creditedEvidence: [] } };
  expect(babysitterModelAdmission(true, snapshot)).toBe(false);
  expect(babysitterModelAdmission(false, { ...snapshot, progressBudget: undefined })).toBe(false);
  expect(babysitterModelAdmission(true, { ...snapshot, pr: { number: 1, head: { sha: "b" } } })).toBe(true);
  expect(babysitterModelAdmission(true, { ...snapshot, progressBudget: undefined })).toBe(true);
});
