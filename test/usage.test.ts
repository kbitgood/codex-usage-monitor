import { describe, expect, test } from "bun:test";
import { parseLiveRateLimits } from "../src/usage";

describe("live Codex usage parsing", () => {
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
    });

    expect(limits).toEqual({
      primary: { used_percent: 6, window_minutes: 300, resets_at: 1_787_869_592 },
      secondary: { used_percent: 1, window_minutes: 10_080, resets_at: 1_788_456_392 },
      plan_type: "team",
      rate_limit_reached_type: null,
      credits: { has_credits: true, unlimited: false, balance: null },
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
