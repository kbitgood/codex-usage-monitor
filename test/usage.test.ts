import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLiveRateLimits, readLiveRateLimits } from "../src/usage";

describe("live Codex usage parsing", () => {
  test("uses an explicit app User-Agent for live requests in Electron", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-usage-"));
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 19,
          limit_window_seconds: 604_800,
          reset_at: 1_791_233_223,
        },
      },
    })));
    try {
      await writeFile(join(directory, "auth.json"), JSON.stringify({
        tokens: { access_token: "test-token", account_id: "test-account" },
      }));
      const limits = await readLiveRateLimits(directory);
      expect(limits.secondary?.used_percent).toBe(19);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        "User-Agent": "Codex Monitor/0.1.0",
        Authorization: "Bearer test-token",
        "ChatGPT-Account-Id": "test-account",
      });
    } finally {
      fetchMock.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps API windows to rollout-compatible rate limits", () => {
    const limits = parseLiveRateLimits({
      plan_type: "team",
      rate_limit: {
        primary_window: {
          used_percent: 6,
          limit_window_seconds: 18_000,
          reset_at: 1_787_869_592,
        },
        secondary_window: {
          used_percent: 1,
          limit_window_seconds: 604_800,
          reset_at: 1_788_456_392,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: null },
      rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
    });

    expect(limits).toEqual({
      primary: { used_percent: 6, window_minutes: 300, resets_at: 1_787_869_592 },
      secondary: { used_percent: 1, window_minutes: 10_080, resets_at: 1_788_456_392 },
      plan_type: "team",
      rate_limit_reached_type: null,
      credits: { has_credits: true, unlimited: false, balance: null },
      bankedResets: 2,
      applicableBankedResets: 0,
    });
  });

  test("rejects incomplete live windows instead of showing misleading data", () => {
    expect(() => parseLiveRateLimits({
      rate_limit: { primary_window: { used_percent: 4 } },
    })).toThrow("invalid window");
  });

  test("treats a premium plan's sole seven-day window as weekly", () => {
    const limits = parseLiveRateLimits({
      plan_type: "self_serve_business_prolite",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 604_800,
          reset_at: 1_788_585_835,
        },
        secondary_window: null,
      },
    });

    expect(limits.primary).toBeNull();
    expect(limits.secondary).toEqual({
      used_percent: 0,
      window_minutes: 10_080,
      resets_at: 1_788_585_835,
    });
  });
});
