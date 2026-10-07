import { describe, expect, it } from "vitest";
import { babysitterAdmissionDecision, babysitterBudgetWindows, readBabysitterAdmissionLimits } from "../src/presets/babysitter/admission.ts";

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
