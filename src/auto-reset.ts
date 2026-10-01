import type { RateLimits, RateLimitWindow } from "./types";

export function exhaustedWindowKey(rateLimits: RateLimits, now = Date.now()): string | undefined {
  if ((rateLimits.bankedResets ?? 0) < 1 || (rateLimits.applicableBankedResets ?? 0) < 1) {
    return undefined;
  }
  const window = [rateLimits.secondary, rateLimits.primary]
    .find((candidate): candidate is RateLimitWindow => Boolean(candidate
      && candidate.used_percent >= 100
      && candidate.resets_at * 1_000 > now));
  return window ? `${window.window_minutes}:${window.resets_at}` : undefined;
}
