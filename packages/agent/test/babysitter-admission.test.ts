import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  babysitterAdmissionDecision,
  babysitterBudgetWindows,
  createBabysitterAdmission,
  readInvocationInputTokens,
  resolveBabysitterAdmissionLimits,
  sumInvocationInputTokens,
  validBabysitterAdmission,
  type BabysitterAdmissionState,
} from "../src/presets/babysitter/admission.ts";

const now = new Date(2026, 9, 5, 19, 13).getTime();
const roomy = (overrides: Partial<BabysitterAdmissionState> = {}): BabysitterAdmissionState => ({
  windows: babysitterBudgetWindows(now), tmpDir: "/scratch", freeTmpBytes: 64 * 2 ** 30, hourlyInputTokens: 0, dailyInputTokens: 0, ...overrides,
});

describe("Babysitter admission", () => {
  it("has no token limit by default and leaves out windows without a limit", () => {
    expect(resolveBabysitterAdmissionLimits()).toEqual({ hourlyInputTokens: undefined, dailyInputTokens: undefined, minFreeTmpBytes: 4096 * 2 ** 20, paused: false });
    const spent = roomy({ hourlyInputTokens: 10e9, dailyInputTokens: 10e9 });
    expect(babysitterAdmissionDecision(spent, resolveBabysitterAdmissionLimits())).toEqual({ accepting: true });
    // Only a daily limit: a large hour does not pause.
    expect(babysitterAdmissionDecision(roomy({ hourlyInputTokens: 900e6 }), resolveBabysitterAdmissionLimits({ inputTokens: { daily: 1e9 } }))).toEqual({ accepting: true });
    expect(resolveBabysitterAdmissionLimits({ minFreeTmpMb: false }).minFreeTmpBytes).toBeUndefined();
    expect(babysitterAdmissionDecision(roomy({ freeTmpBytes: 0 }), resolveBabysitterAdmissionLimits({ minFreeTmpMb: false }))).toEqual({ accepting: true });
  });

  it("validates the admission option", () => {
    for (const value of [{}, { inputTokens: { daily: 1e9 } }, { inputTokens: { hourly: 0 } }, { minFreeTmpMb: false }, { paused: true, check: () => undefined }]) {
      expect(validBabysitterAdmission(value)).toBe(true);
    }
    for (const value of [undefined, { inputTokens: { daily: -1 } }, { inputTokens: { hourly: 1.5 } }, { inputTokens: 5 }, { minFreeTmpMb: "4096" }, { paused: "yes" }, { check: true }]) {
      expect(validBabysitterAdmission(value)).toBe(false);
    }
  });

  it("stops every claim while paused and only model passes for spent resources", () => {
    expect(babysitterAdmissionDecision(roomy(), resolveBabysitterAdmissionLimits({ paused: true }))).toMatchObject({ accepting: false, hostOnly: false, reason: "paused" });
    const limits = resolveBabysitterAdmissionLimits({ inputTokens: { hourly: 15e6, daily: 200e6 } });
    for (const state of [
      roomy({ freeTmpBytes: 2 ** 20 }),
      roomy({ hourlyInputTokens: 15e6 }),
      roomy({ dailyInputTokens: 200e6 }),
      roomy({ pause: { reason: "provider-quota" } }),
    ]) expect(babysitterAdmissionDecision(state, limits)).toMatchObject({ accepting: false, hostOnly: true });
    // A zero budget is a spent budget, not a pause: merges continue.
    expect(babysitterAdmissionDecision(roomy(), resolveBabysitterAdmissionLimits({ inputTokens: { daily: 0 } }))).toMatchObject({ accepting: false, hostOnly: true, reason: "token-budget-daily" });
  });

  it("skips a pass while the temporary directory is low on space", () => {
    const limits = resolveBabysitterAdmissionLimits();
    expect(babysitterAdmissionDecision(roomy(), limits)).toEqual({ accepting: true });
    const low = babysitterAdmissionDecision(roomy({ freeTmpBytes: 3 * 2 ** 30 }), limits);
    expect(low).toMatchObject({ accepting: false, reason: "tmp-space-low" });
    expect(low.detail).toMatch(/3072 MiB free in \/scratch/);
  });

  it("pauses a spent token budget until the next window", () => {
    const windows = babysitterBudgetWindows(now);
    expect(windows.hourEnd).toBe(new Date(2026, 9, 5, 20).getTime());
    expect(windows.dayEnd).toBe(new Date(2026, 9, 6).getTime());
    const limits = resolveBabysitterAdmissionLimits({ inputTokens: { hourly: 1, daily: 200e6 } });
    expect(babysitterAdmissionDecision(roomy({ hourlyInputTokens: 1 }), limits)).toMatchObject({ accepting: false, reason: "token-budget-hourly", retryAt: windows.hourEnd });
    expect(babysitterAdmissionDecision(roomy({ windows: babysitterBudgetWindows(windows.hourEnd) }), limits).accepting).toBe(true);
    expect(babysitterAdmissionDecision(roomy({ dailyInputTokens: 200e6 }), limits)).toMatchObject({ accepting: false, reason: "token-budget-daily", retryAt: windows.dayEnd });
  });

  // Rows relative to `now` (19:13 local): one from yesterday, one earlier today, three this hour.
  async function invocationStore() {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-babysitter-admission-"));
    directories.push(directory);
    const file = join(directory, "invocations.sqlite");
    const { hourStart, dayStart } = babysitterBudgetWindows(now);
    const at = (time: number) => new Date(time).toISOString();
    const record = (...tokens: number[]) => JSON.stringify({ observations: [{ attributes: {} }, ...tokens.map(value => ({ attributes: { "usage.inputTokens": value } }))] });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE vitehub_agent_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO vitehub_agent_invocations (id, status, updated_at, record) VALUES (?, ?, ?, ?)");
    insert.run("old", "completed", at(dayStart - 60_000), record(900_000));
    insert.run("a", "completed", at(hourStart - 30 * 60_000), record(100_000, 200_000));
    insert.run("b", "completed", at(hourStart + 5 * 60_000), record(27_241, 55_163, 85_835));
    insert.run("c", "running", at(hourStart + 10 * 60_000), record(40_000));
    insert.run("d", "completed", at(hourStart + 11 * 60_000), record());
    db.close();
    // The running pass reports a larger cumulative total.
    const grow = (time: number) => {
      const writer = new DatabaseSync(file);
      writer.prepare("UPDATE vitehub_agent_invocations SET updated_at = ?, record = ? WHERE id = ?").run(at(time), record(40_000, 70_000), "c");
      writer.close();
    };
    return { directory, file, grow, hourStart, dayStart };
  }
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  it("reads each invocation once at its cumulative maximum and refreshes only recent rows", async () => {
    const store = await invocationStore();
    const rows = await readInvocationInputTokens(store.file, store.dayStart);
    expect(rows.map(row => row.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(rows.find(row => row.id === "c")).toEqual({ id: "c", updatedAt: store.hourStart + 10 * 60_000, tokens: 40_000 });
    const usage = new Map(rows.map(row => [row.id, row]));
    expect(sumInvocationInputTokens(usage, store.hourStart)).toBe(125_835);
    expect(sumInvocationInputTokens(usage, store.dayStart)).toBe(325_835);
    store.grow(now - 30_000);
    const fresh = await readInvocationInputTokens(store.file, now - 90_000);
    expect(fresh.map(row => row.id)).toEqual(["c"]);
    for (const row of fresh) usage.set(row.id, row);
    expect(sumInvocationInputTokens(usage, store.hourStart)).toBe(155_835);
  });

  it("refreshes token usage incrementally and keeps the last totals when a read fails", async () => {
    const store = await invocationStore();
    const check = createBabysitterAdmission({ invocationsFile: store.file, limits: resolveBabysitterAdmissionLimits({ inputTokens: { daily: 1e9 } }) });
    const first = await check(now);
    expect([first.state.hourlyInputTokens, first.state.dailyInputTokens]).toEqual([125_835, 325_835]);
    store.grow(now + 30_000);
    // Reads run at most once a minute.
    expect((await check(now + 30_000)).state.hourlyInputTokens).toBe(125_835);
    expect((await check(now + 60_000)).state.hourlyInputTokens).toBe(155_835);
    await rm(store.file);
    const failed = await check(now + 120_000);
    expect([failed.state.hourlyInputTokens, failed.state.dailyInputTokens]).toEqual([155_835, 355_835]);
    expect(failed.state.errors).toEqual([expect.stringMatching(/^tokens: /)]);
  });

  it("reads no token usage without a token limit", async () => {
    const check = createBabysitterAdmission({ invocationsFile: "/nonexistent/invocations.sqlite", limits: resolveBabysitterAdmissionLimits() });
    const result = await check(now);
    expect(result.accepting).toBe(true);
    expect([result.state.hourlyInputTokens, result.state.dailyInputTokens]).toEqual([undefined, undefined]);
    expect(result.state.errors).toBeUndefined();
  });

  it("pauses model passes for a custom check and reports a failing check without pausing", async () => {
    let quota: "ok" | "spent" | "broken" = "ok";
    const check = createBabysitterAdmission({
      invocationsFile: "/nonexistent/invocations.sqlite",
      limits: resolveBabysitterAdmissionLimits(),
      check: async () => {
        if (quota === "broken") throw new Error("status file unreadable");
        return quota === "spent" ? { reason: "provider-quota", detail: "2 of 5 accounts usable", retryAt: now + 60_000 } : undefined;
      },
    });
    expect((await check(now)).accepting).toBe(true);
    quota = "spent";
    expect(await check(now)).toMatchObject({ accepting: false, hostOnly: true, reason: "provider-quota", detail: "2 of 5 accounts usable", retryAt: now + 60_000 });
    quota = "broken";
    const broken = await check(now);
    expect(broken.accepting).toBe(true);
    expect(broken.state.errors).toEqual(["check: status file unreadable"]);
  });
});
