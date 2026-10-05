import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  babysitterAdmissionDecision,
  babysitterBudgetWindows,
  createBabysitterAdmission,
  readBabysitterAdmissionLimits,
  readInvocationInputTokens,
  sumInvocationInputTokens,
  summarizeProxyAccounts,
  type BabysitterAdmissionState,
} from "../src/presets/babysitter/admission.ts";

const now = new Date(2026, 9, 5, 19, 13).getTime();
const roomy = (overrides: Partial<BabysitterAdmissionState> = {}): BabysitterAdmissionState => ({
  windows: babysitterBudgetWindows(now), tmpDir: "/scratch", freeTmpBytes: 64 * 2 ** 30, hourlyInputTokens: 0, dailyInputTokens: 0, proxy: { state: "unknown" }, ...overrides,
});

describe("Babysitter admission", () => {
  it("reads limits from the environment with safe defaults", () => {
    expect(readBabysitterAdmissionLimits({})).toEqual({
      minFreeTmpBytes: 4096 * 2 ** 20,
      hourlyInputTokens: 15e6,
      dailyInputTokens: 200e6,
      proxyStatusFile: "/srv/cliproxy-status/accounts.json",
      proxyProvider: "codex",
      proxyMaxWeeklyPercent: 80,
      proxyStatusMaxAgeMs: 900_000,
    });
    const forced = readBabysitterAdmissionLimits({ BABYSITTER_HOURLY_INPUT_TOKENS: "0", BABYSITTER_DAILY_INPUT_TOKENS: "lots", BABYSITTER_MIN_FREE_TMP_MB: "512", BABYSITTER_PROXY_STATUS_MAX_AGE_S: "60" }, "claude");
    expect(forced).toMatchObject({ hourlyInputTokens: 0, dailyInputTokens: 200e6, minFreeTmpBytes: 512 * 2 ** 20, proxyStatusMaxAgeMs: 60_000, proxyProvider: "claude" });
    expect(readBabysitterAdmissionLimits({ BABYSITTER_PROXY_PROVIDER: "gemini" }, "claude").proxyProvider).toBe("gemini");
    // A zero budget pauses admission.
    expect(babysitterAdmissionDecision(roomy(), forced)).toMatchObject({ accepting: false, reason: "token-budget-hourly" });
  });

  it("skips a pass while the temporary directory is low on space", () => {
    const limits = readBabysitterAdmissionLimits({});
    expect(babysitterAdmissionDecision(roomy(), limits)).toEqual({ accepting: true });
    const low = babysitterAdmissionDecision(roomy({ freeTmpBytes: 3 * 2 ** 30 }), limits);
    expect(low).toMatchObject({ accepting: false, reason: "tmp-space-low" });
    expect(low.detail).toMatch(/3072 MiB free in \/scratch/);
  });

  it("pauses a spent token budget until the next window", () => {
    const windows = babysitterBudgetWindows(now);
    expect(windows.hourEnd).toBe(new Date(2026, 9, 5, 20).getTime());
    expect(windows.dayEnd).toBe(new Date(2026, 9, 6).getTime());
    const limits = readBabysitterAdmissionLimits({ BABYSITTER_HOURLY_INPUT_TOKENS: "1" });
    expect(babysitterAdmissionDecision(roomy({ hourlyInputTokens: 1 }), limits)).toMatchObject({ accepting: false, reason: "token-budget-hourly", retryAt: windows.hourEnd });
    expect(babysitterAdmissionDecision(roomy({ windows: babysitterBudgetWindows(windows.hourEnd) }), limits).accepting).toBe(true);
    expect(babysitterAdmissionDecision(roomy({ dailyInputTokens: 200e6 }), readBabysitterAdmissionLimits({}))).toMatchObject({ accepting: false, reason: "token-budget-daily", retryAt: windows.dayEnd });
  });

  it("pauses for exhausted or mostly used proxy accounts and ignores stale status", () => {
    const limits = readBabysitterAdmissionLimits({});
    const status = (accounts: unknown[], observedAt = new Date(now).toISOString()) => summarizeProxyAccounts({ observedAt, accounts }, "codex", now, limits.proxyStatusMaxAgeMs);
    const account = (weeklyUsedPercent: number | undefined, extra = {}) => ({ provider: "codex", available: true, limitReached: false, weeklyUsedPercent, ...extra });
    const mixed = status([account(100, { limitReached: true }), account(100, { limitReached: true }), account(21), account(undefined), { provider: "claude", available: false }]);
    expect(mixed).toMatchObject({ state: "fresh", accounts: 4, usable: 2, weeklyUsedPercent: 74 });
    expect(babysitterAdmissionDecision(roomy({ proxy: mixed }), limits).accepting).toBe(true);
    const weekly = status([account(100, { limitReached: true }), account(85), account(60)]);
    expect(babysitterAdmissionDecision(roomy({ proxy: weekly }), limits)).toMatchObject({ accepting: false, reason: "proxy-weekly-limit" });
    const exhausted = status([account(10, { available: false }), account(100, { limitReached: true })]);
    expect(babysitterAdmissionDecision(roomy({ proxy: exhausted }), limits)).toMatchObject({ accepting: false, reason: "proxy-exhausted" });
    const stale = status([account(100, { limitReached: true })], new Date(now - 3_600_000).toISOString());
    expect(stale.state).toBe("stale");
    expect(babysitterAdmissionDecision(roomy({ proxy: stale }), limits).accepting).toBe(true);
    expect(summarizeProxyAccounts({ accounts: [account(100, { limitReached: true })] }, "codex", now, limits.proxyStatusMaxAgeMs).state).toBe("stale");
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
    const check = createBabysitterAdmission({
      invocationsFile: store.file,
      limits: readBabysitterAdmissionLimits({ BABYSITTER_PROXY_STATUS_FILE: join(store.directory, "missing.json") }),
    });
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
    expect(failed.state.proxy).toEqual({ state: "unknown" });
  });
});
