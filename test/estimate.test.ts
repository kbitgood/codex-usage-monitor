import { describe, expect, test } from "bun:test";
import { estimatePaidCreditsFromRollouts } from "../src/estimate";

function line(timestamp: string, total: object, usedPercent: number, resetAt: number): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total },
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: resetAt },
      },
    },
  });
}

describe("paid credit estimation", () => {
  test("counts the 99 percent boundary and the request that reaches 100 percent", () => {
    const resetAt = Date.parse("2026-09-16T00:00:00Z") / 1_000;
    const text = [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", service_tier: "default" } }),
      line("2026-09-15T10:00:00Z", { input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 10_000 }, 99, resetAt),
      line("2026-09-15T10:01:00Z", { input_tokens: 2_000_000, cached_input_tokens: 1_000_000, output_tokens: 20_000 }, 100, resetAt),
      line("2026-09-15T10:02:00Z", { input_tokens: 3_000_000, cached_input_tokens: 1_500_000, output_tokens: 30_000 }, 100, resetAt),
      line("2026-09-15T10:02:01Z", { input_tokens: 3_000_000, cached_input_tokens: 1_500_000, output_tokens: 30_000 }, 100, resetAt),
    ].join("\n");

    const result = estimatePaidCreditsFromRollouts(
      [{ path: "rollout.jsonl", text }],
      new Date("2026-09-15T12:00:00Z"),
    );

    expect(result.at(-1)?.credits).toBe(180);
    expect(result.at(-1)?.boundaryCredits).toBe(120);
    expect(result.at(-1)?.confirmedCredits).toBe(60);
  });

  test("does not count usage after the exhausted window resets", () => {
    const resetAt = Date.parse("2026-09-15T10:01:30Z") / 1_000;
    const text = [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna", service_tier: "default" } }),
      line("2026-09-15T10:00:00Z", { input_tokens: 10, output_tokens: 10 }, 100, resetAt),
      line("2026-09-15T10:02:00Z", { input_tokens: 1_000_010, output_tokens: 1_000_010 }, 0, resetAt + 18_000),
    ].join("\n");

    const result = estimatePaidCreditsFromRollouts(
      [{ path: "rollout.jsonl", text }],
      new Date("2026-09-15T12:00:00Z"),
    );

    expect(result.at(-1)?.credits).toBeCloseTo(0.00000035);
  });

  test("keeps an exhausted window latched across stale concurrent reports", () => {
    const resetAt = Date.parse("2026-09-16T00:00:00Z") / 1_000;
    const first = [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna", service_tier: "default" } }),
      line("2026-09-15T10:00:00Z", { input_tokens: 10, output_tokens: 10 }, 100, resetAt),
      line("2026-09-15T10:02:00Z", { input_tokens: 1_000_010, output_tokens: 1_000_010 }, 100, resetAt),
    ].join("\n");
    const stale = [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna", service_tier: "default" } }),
      line("2026-09-15T10:01:00Z", { input_tokens: 10, output_tokens: 10 }, 99, resetAt),
      line("2026-09-15T10:03:00Z", { input_tokens: 1_000_010, output_tokens: 1_000_010 }, 99, resetAt),
    ].join("\n");

    const result = estimatePaidCreditsFromRollouts([
      { path: "first.jsonl", text: first },
      { path: "stale.jsonl", text: stale },
    ], new Date("2026-09-15T12:00:00Z"));

    expect(result.at(-1)?.credits).toBeCloseTo(70.0000007);
  });

  test("uses Astra rates and a Fast reserve when metadata is unknown", () => {
    const resetAt = Date.parse("2026-09-16T00:00:00Z") / 1_000;
    const text = [
      line("2026-09-15T10:00:00Z", { input_tokens: 0, output_tokens: 0 }, 100, resetAt),
      line("2026-09-15T10:01:00Z", { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 100, resetAt),
    ].join("\n");

    const result = estimatePaidCreditsFromRollouts(
      [{ path: "rollout.jsonl", text }],
      new Date("2026-09-15T12:00:00Z"),
      "unknown",
    );

    expect(result.at(-1)?.metadataReserve).toBe(1_500);
    expect(result.at(-1)?.speedReserve).toBe(2_250);
    expect(result.at(-1)?.credits).toBe(3_750);
  });
});
