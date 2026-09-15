import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CreditDay, RateLimitWindow, UsageNumbers } from "./types";

interface CreditRates {
  input: number;
  cachedInput: number;
  output: number;
}

interface UsageEvent {
  source: string;
  timestamp: number;
  model?: string;
  serviceTier?: string;
  total: UsageNumbers;
  delta?: UsageNumbers;
  windows: RateLimitWindow[];
}

interface RolloutEvent {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
}

const rates: Record<string, CreditRates> = {
  "gpt-6-astra": { input: 250, cachedInput: 25, output: 1_250 },
  "gpt-5.6-sol": { input: 100, cachedInput: 10, output: 500 },
  "gpt-5.6-terra": { input: 50, cachedInput: 5, output: 300 },
  "gpt-5.6-luna": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.5": { input: 125, cachedInput: 12.5, output: 750 },
  "gpt-5.4": { input: 62.5, cachedInput: 6.25, output: 375 },
  "gpt-5.4-mini": { input: 18.75, cachedInput: 1.875, output: 113 },
  "gpt-5.3-codex": { input: 43.75, cachedInput: 4.375, output: 350 },
  "gpt-5.2": { input: 43.75, cachedInput: 4.375, output: 350 },
};
const upperBoundRate = rates["gpt-6-astra"] as CreditRates;
const fastMultiplier = 2.5;
type ServiceTier = "default" | "fast" | "unknown";

interface CreditParts {
  confirmedCredits: number;
  boundaryCredits: number;
  metadataReserve: number;
  speedReserve: number;
}

export async function estimatePaidCreditDays(
  codexDirectory: string,
  now = new Date(),
): Promise<CreditDay[]> {
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 7,
  )).getTime();
  const paths = (await Promise.all([
    findRecentRollouts(join(codexDirectory, "sessions"), start),
    findRecentRollouts(join(codexDirectory, "archived_sessions"), start),
  ])).flat();
  const files = await Promise.all(paths.map(async (path) => ({
    path,
    text: await readFile(path, "utf8"),
  })));
  const serviceTier = await readServiceTier(codexDirectory);
  return estimatePaidCreditsFromRollouts(files, now, serviceTier);
}

export function estimatePaidCreditsFromRollouts(
  files: Array<{ path: string; text: string }>,
  now = new Date(),
  serviceTier: ServiceTier = "default",
): CreditDay[] {
  const events = files.flatMap(({ path, text }) => parseUsageEvents(path, text));
  const previousTotals = new Map<string, UsageNumbers>();
  for (const event of events) {
    event.delta = subtractUsage(event.total, previousTotals.get(event.source));
    previousTotals.set(event.source, event.total);
  }
  const uniqueEvents = new Map<string, UsageEvent>();
  for (const event of events) {
    const key = [
      event.timestamp,
      event.total.input_tokens ?? 0,
      event.total.cached_input_tokens ?? 0,
      event.total.output_tokens ?? 0,
    ].join(":");
    const existing = uniqueEvents.get(key);
    if (!existing || deltaTokens(event.delta) < deltaTokens(existing.delta)) {
      uniqueEvents.set(key, event);
    }
  }
  const chronologicalEvents = [...uniqueEvents.values()]
    .sort((left, right) => left.timestamp - right.timestamp);

  const creditsByDay = new Map<string, CreditParts>();
  const exhaustedWindows = new Map<number, number>();

  for (const event of chronologicalEvents) {
    for (const [duration, resetAt] of exhaustedWindows) {
      if (event.timestamp >= resetAt) exhaustedWindows.delete(duration);
    }
    const boundary = !exhaustedWindows.size
      && event.windows.some((window) => window.used_percent >= 99);
    if (exhaustedWindows.size || boundary) {
      const knownRate = event.model ? modelRates(event.model) : undefined;
      const baseCredits = calculateCredits(event.delta ?? {}, knownRate ?? upperBoundRate);
      const multiplier = speedMultiplier(event.serviceTier, serviceTier);
      const parts = creditParts(creditsByDay, event.timestamp);
      if (boundary) parts.boundaryCredits += baseCredits;
      else if (!knownRate) parts.metadataReserve += baseCredits;
      else parts.confirmedCredits += baseCredits;
      parts.speedReserve += baseCredits * (multiplier - 1);
    }
    for (const window of event.windows) {
      const resetAt = window.resets_at * 1_000;
      const exhaustedReset = exhaustedWindows.get(window.window_minutes);
      if (window.used_percent >= 100) {
        exhaustedWindows.set(window.window_minutes, resetAt);
      } else if (exhaustedReset !== undefined && exhaustedReset !== resetAt) {
        exhaustedWindows.delete(window.window_minutes);
      }
    }
  }

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: 7 }, (_, index): CreditDay => {
    const date = new Date(today - (6 - index) * 86_400_000).toISOString().slice(0, 10);
    return {
      date,
      credits: sumCreditParts(creditsByDay.get(date)),
      partial: index === 6,
      ...creditsByDay.get(date),
    };
  });
}

function creditParts(byDay: Map<string, CreditParts>, timestamp: number): CreditParts {
  const day = new Date(timestamp).toISOString().slice(0, 10);
  let parts = byDay.get(day);
  if (!parts) {
    parts = { confirmedCredits: 0, boundaryCredits: 0, metadataReserve: 0, speedReserve: 0 };
    byDay.set(day, parts);
  }
  return parts;
}

function sumCreditParts(parts?: CreditParts): number {
  if (!parts) return 0;
  return parts.confirmedCredits + parts.boundaryCredits + parts.metadataReserve + parts.speedReserve;
}

function parseUsageEvents(source: string, text: string): UsageEvent[] {
  const events: UsageEvent[] = [];
  let model: string | undefined;
  let serviceTier: string | undefined;

  for (const line of text.split("\n")) {
    let event: RolloutEvent;
    try {
      event = JSON.parse(line) as RolloutEvent;
    } catch {
      continue;
    }

    if (event.type === "turn_context") {
      model = stringValue(event.payload?.model) ?? model;
      serviceTier = stringValue(event.payload?.service_tier) ?? serviceTier;
      continue;
    }
    if (event.type !== "event_msg" || event.payload?.type !== "token_count") continue;

    const timestamp = Date.parse(stringValue(event.timestamp) ?? "");
    const info = objectValue(event.payload.info);
    const total = objectValue(info?.total_token_usage) as UsageNumbers | undefined;
    const limits = objectValue(event.payload.rate_limits);
    if (!Number.isFinite(timestamp) || !total || !limits) continue;

    events.push({
      source,
      timestamp,
      model,
      serviceTier: stringValue(event.payload.service_tier)
        ?? stringValue(info?.service_tier)
        ?? serviceTier,
      total,
      windows: [limits.primary, limits.secondary]
        .map(parseWindow)
        .filter((window): window is RateLimitWindow => Boolean(window)),
    });
  }
  return events;
}

function subtractUsage(current: UsageNumbers, previous?: UsageNumbers): UsageNumbers {
  return {
    input_tokens: positiveDelta(current.input_tokens, previous?.input_tokens ?? 0),
    cached_input_tokens: positiveDelta(current.cached_input_tokens, previous?.cached_input_tokens ?? 0),
    output_tokens: positiveDelta(current.output_tokens, previous?.output_tokens ?? 0),
  };
}

function calculateCredits(usage: UsageNumbers, creditRate: CreditRates): number {
  const input = usage.input_tokens ?? 0;
  const cached = Math.min(input, usage.cached_input_tokens ?? 0);
  const uncached = Math.max(0, input - cached);
  const output = usage.output_tokens ?? 0;
  return (
    uncached * creditRate.input
    + cached * creditRate.cachedInput
    + output * creditRate.output
  ) / 1_000_000;
}

function modelRates(model: string): CreditRates | undefined {
  const normalized = model.toLowerCase().replaceAll("_", "-");
  return rates[normalized]
    ?? Object.entries(rates).find(([name]) => normalized.startsWith(`${name}-`))?.[1];
}

function speedMultiplier(recordedTier: string | undefined, configuredTier: ServiceTier): number {
  const tier = recordedTier?.toLowerCase();
  if (tier === "default" || tier === "flex") return 1;
  if (tier === "fast" || tier === "priority" || tier === "ultrafast") return fastMultiplier;
  if (configuredTier === "fast") return fastMultiplier;
  return fastMultiplier;
}

function parseWindow(value: unknown): RateLimitWindow | undefined {
  const window = objectValue(value);
  if (!window) return undefined;
  const usedPercent = numberValue(window.used_percent);
  const windowMinutes = numberValue(window.window_minutes);
  const resetsAt = numberValue(window.resets_at);
  if (usedPercent === undefined || windowMinutes === undefined || resetsAt === undefined) {
    return undefined;
  }
  return { used_percent: usedPercent, window_minutes: windowMinutes, resets_at: resetsAt };
}

function positiveDelta(current?: number, previous?: number): number {
  if (current === undefined || previous === undefined) return 0;
  return Math.max(0, current - previous);
}

function deltaTokens(usage?: UsageNumbers): number {
  return (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function findRecentRollouts(root: string, start: number): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const dateMatch = basename(path).match(/rollout-(\d{4}-\d{2}-\d{2})/);
        const namedAt = dateMatch ? Date.parse(`${dateMatch[1]}T00:00:00Z`) : 0;
        const modifiedAt = (await stat(path)).mtimeMs;
        if (namedAt >= start || modifiedAt >= start) results.push(path);
      }
    }));
  }
  await visit(root);
  return results;
}

async function readServiceTier(codexDirectory: string): Promise<ServiceTier> {
  try {
    const config = await readFile(join(codexDirectory, "config.toml"), "utf8");
    const value = config.match(/^\s*service_tier\s*=\s*["']([^"']+)["']/m)?.[1]?.toLowerCase();
    if (value === "default" || value === "flex") return "default";
    if (value === "fast" || value === "priority" || value === "ultrafast") return "fast";
    return "unknown";
  } catch {
    return "unknown";
  }
}
