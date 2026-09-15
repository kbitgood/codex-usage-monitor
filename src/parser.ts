import type {
  MonitorSnapshot,
  ParsedEvent,
  RateLimits,
  UsageNumbers,
} from "./types";

interface SessionDetails {
  sessionId?: string;
  cwd?: string;
  cliVersion?: string;
  originator?: string;
  model?: string;
  effort?: string;
}

function parseLine(line: string): ParsedEvent | undefined {
  if (!line.trimStart().startsWith("{")) return undefined;

  try {
    return JSON.parse(line) as ParsedEvent;
  } catch {
    return undefined;
  }
}

export function findLatestTokenEvent(text: string): ParsedEvent | undefined {
  const lines = text.trimEnd().split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = parseLine(lines[index] ?? "");
    if (
      event?.type === "event_msg" &&
      event.payload?.type === "token_count" &&
      event.payload.rate_limits
    ) {
      return event;
    }
  }

  return undefined;
}

export function parseSessionDetails(head: string, tail: string): SessionDetails {
  const details: SessionDetails = {};

  for (const line of head.split("\n")) {
    const event = parseLine(line);
    if (event?.type !== "session_meta") continue;
    const payload = event.payload ?? {};
    details.sessionId = stringValue(payload.session_id ?? payload.id);
    details.cwd = stringValue(payload.cwd);
    details.cliVersion = stringValue(payload.cli_version);
    details.originator = stringValue(payload.originator);
    break;
  }

  const lines = tail.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = parseLine(lines[index] ?? "");
    if (event?.type !== "turn_context") continue;
    const payload = event.payload ?? {};
    details.cwd = stringValue(payload.cwd) ?? details.cwd;
    details.model = stringValue(payload.model);
    details.effort = stringValue(payload.effort);
    break;
  }

  return details;
}

export function buildSnapshot(
  event: ParsedEvent,
  sourceFile: string,
  details: SessionDetails,
): MonitorSnapshot | undefined {
  const payload = event.payload;
  if (!payload || payload.type !== "token_count") return undefined;

  const info = objectValue(payload.info);
  const rateLimits = objectValue(payload.rate_limits) as RateLimits | undefined;
  if (!info || !rateLimits || !event.timestamp) return undefined;

  return {
    eventTimestamp: event.timestamp,
    sourceFile,
    ...details,
    totalUsage: (objectValue(info.total_token_usage) ?? {}) as UsageNumbers,
    lastUsage: (objectValue(info.last_token_usage) ?? {}) as UsageNumbers,
    contextWindow: numberValue(info.model_context_window),
    rateLimits,
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
