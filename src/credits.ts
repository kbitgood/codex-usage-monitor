import type { CreditDay } from "./types";

export interface CodexAdminIdentity {
  workspaceId: string;
  userId: string;
}

interface CreditPointPayload {
  bucket_start?: unknown;
  value?: unknown;
  is_partial?: unknown;
}

interface CreditSeriesPayload {
  dimensions?: { product?: unknown };
  points?: CreditPointPayload[];
}

interface CreditsPayload {
  charts?: {
    credits?: {
      series?: CreditSeriesPayload[];
    };
  };
}

export function parseCodexAdminIdentity(authFile: string): CodexAdminIdentity | undefined {
  try {
    const auth = JSON.parse(authFile) as { tokens?: { id_token?: string } };
    const token = auth.tokens?.id_token;
    if (!token) return undefined;

    const payloadPart = token.split(".")[1];
    if (!payloadPart) return undefined;

    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: {
        chatgpt_account_id?: unknown;
        chatgpt_user_id?: unknown;
      };
    };
    const claims = payload["https://api.openai.com/auth"];
    const workspaceId = claims?.chatgpt_account_id;
    const userId = claims?.chatgpt_user_id;
    if (typeof workspaceId !== "string" || typeof userId !== "string") return undefined;
    return { workspaceId, userId };
  } catch {
    return undefined;
  }
}

export function buildCreditsPageUrl(identity: CodexAdminIdentity): string {
  const path = `/workspace/${encodeURIComponent(identity.workspaceId)}/analytics/credits`;
  const url = new URL(path, "https://admin.openai.com");
  url.searchParams.set("user_id", identity.userId);
  return url.toString();
}

export function buildCreditsDataUrl(
  identity: CodexAdminIdentity,
  now = new Date(),
): string {
  const url = new URL(
    "/api/agent-observability-v3/credits/usage",
    "https://admin.openai.com",
  );
  url.searchParams.set("window", "1m");
  url.searchParams.set("end_date", now.toISOString().slice(0, 10));
  url.searchParams.set("group_by", "day");
  url.searchParams.set("breakdown", "product");
  url.searchParams.set("balance_unit", "credit");
  url.searchParams.set("include_filter_metadata", "true");
  url.searchParams.append("products", "codex");
  url.searchParams.append("products", "chatgpt");
  url.searchParams.set("workspace_ids", identity.workspaceId);
  url.searchParams.set("user_ids", identity.userId);
  return url.toString();
}

export function parseCreditDays(payload: unknown): CreditDay[] {
  const series = (payload as CreditsPayload)?.charts?.credits?.series;
  const codex = series?.find((item) => item.dimensions?.product === "codex");
  if (!codex?.points) return [];

  return codex.points
    .flatMap((point): CreditDay[] => {
      if (typeof point.bucket_start !== "string" || typeof point.value !== "number") {
        return [];
      }
      return [{
        date: point.bucket_start.slice(0, 10),
        credits: Math.max(0, point.value),
        partial: point.is_partial === true,
      }];
    })
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-7);
}
