import { describe, expect, test } from "bun:test";
import { buildSnapshot, findLatestTokenEvent, parseSessionDetails } from "../src/parser";

const meta = JSON.stringify({
  timestamp: "2026-08-26T20:00:00.000Z",
  type: "session_meta",
  payload: {
    session_id: "session-123",
    cwd: "/tmp/project",
    cli_version: "0.150.0",
    originator: "codex_cli_rs",
  },
});

const context = JSON.stringify({
  timestamp: "2026-08-26T20:00:01.000Z",
  type: "turn_context",
  payload: { model: "gpt-5.6-sol", effort: "medium", cwd: "/tmp/new-project" },
});

const token = JSON.stringify({
  timestamp: "2026-08-26T20:00:02.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: 12000 },
      last_token_usage: { total_tokens: 2000 },
      model_context_window: 258400,
    },
    rate_limits: {
      primary: { used_percent: 43, window_minutes: 300, resets_at: 1787800579 },
      secondary: { used_percent: 13, window_minutes: 10080, resets_at: 1788369051 },
      plan_type: "team",
    },
  },
});

describe("rollout parsing", () => {
  test("finds the newest valid token event", () => {
    const older = token.replace("43", "40").replace("20:00:02", "19:00:02");
    const event = findLatestTokenEvent([older, "not-json", token, "{"].join("\n"));
    expect(event?.timestamp).toBe("2026-08-26T20:00:02.000Z");
    expect(event?.payload?.rate_limits).toBeTruthy();
  });

  test("combines session, turn, usage, and rate-limit data", () => {
    const details = parseSessionDetails(meta, context);
    const event = findLatestTokenEvent(token);
    const snapshot = buildSnapshot(event!, "/tmp/rollout.jsonl", details);

    expect(snapshot).toMatchObject({
      sessionId: "session-123",
      cwd: "/tmp/new-project",
      model: "gpt-5.6-sol",
      effort: "medium",
      contextWindow: 258400,
      rateLimits: { plan_type: "team" },
    });
  });

  test("ignores a token event with no limits", () => {
    const event = findLatestTokenEvent(
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {} } }),
    );
    expect(event).toBeUndefined();
  });
});
