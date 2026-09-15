import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readLatestSnapshot } from "./reader";
import type { MonitorSnapshot, RateLimits, RateLimitWindow } from "./types";

const usageUrl = "https://chatgpt.com/backend-api/codex/usage";

interface CodexAuth {
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

interface LiveWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

interface LiveUsagePayload {
  plan_type?: unknown;
  rate_limit_reached_type?: unknown;
  rate_limit?: {
    primary_window?: LiveWindow | null;
    secondary_window?: LiveWindow | null;
  } | null;
  credits?: RateLimits["credits"];
}

export async function readCurrentSnapshot(
  codexDirectory: string,
): Promise<MonitorSnapshot | undefined> {
  const [localResult, liveResult] = await Promise.allSettled([
    readLatestSnapshot(codexDirectory),
    readLiveRateLimits(codexDirectory),
  ]);
  const local = localResult.status === "fulfilled" ? localResult.value : undefined;
  const live = liveResult.status === "fulfilled" ? liveResult.value : undefined;

  if (!live) {
    return local ? { ...local, rateLimits: normalizeRateLimits(local.rateLimits) } : undefined;
  }
  return {
    ...(local ?? { totalUsage: {}, lastUsage: {} }),
    eventTimestamp: new Date().toISOString(),
    sourceFile: usageUrl,
    rateLimits: live,
  };
}

export async function readLiveRateLimits(codexDirectory: string): Promise<RateLimits> {
  const auth = JSON.parse(
    await readFile(join(codexDirectory, "auth.json"), "utf8"),
  ) as CodexAuth;
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (typeof accessToken !== "string" || typeof accountId !== "string") {
    throw new Error("Codex login credentials not found");
  }

  const response = await fetch(usageUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Live Codex usage request failed (${response.status})`);
  return parseLiveRateLimits(await response.json());
}

export function parseLiveRateLimits(payload: unknown): RateLimits {
  const usage = payload as LiveUsagePayload;
  if (!usage?.rate_limit) throw new Error("Live Codex usage response has no rate limit");

  return normalizeRateLimits({
    primary: parseLiveWindow(usage.rate_limit.primary_window),
    secondary: parseLiveWindow(usage.rate_limit.secondary_window),
    plan_type: stringOrNull(usage.plan_type),
    rate_limit_reached_type: stringOrNull(usage.rate_limit_reached_type),
    credits: usage.credits ?? null,
  });
}

export function normalizeRateLimits(rateLimits: RateLimits): RateLimits {
  const windows = [rateLimits.primary, rateLimits.secondary]
    .filter((window): window is RateLimitWindow => Boolean(window))
    .sort((left, right) => left.window_minutes - right.window_minutes);

  if (windows.length === 1) {
    const [window] = windows;
    return {
      ...rateLimits,
      primary: window && window.window_minutes < 1_440 ? window : null,
      secondary: window && window.window_minutes >= 1_440 ? window : null,
    };
  }

  return {
    ...rateLimits,
    primary: windows[0] ?? null,
    secondary: windows.at(-1) ?? null,
  };
}

function parseLiveWindow(window: LiveWindow | null | undefined): RateLimitWindow | null {
  if (!window) return null;
  const usedPercent = numberValue(window.used_percent);
  const windowSeconds = numberValue(window.limit_window_seconds);
  const resetsAt = numberValue(window.reset_at);
  if (usedPercent === undefined || windowSeconds === undefined || resetsAt === undefined) {
    throw new Error("Live Codex usage response has an invalid window");
  }
  return {
    used_percent: usedPercent,
    window_minutes: windowSeconds / 60,
    resets_at: resetsAt,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
