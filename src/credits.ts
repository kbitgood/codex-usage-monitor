import type { CreditDay, CreditSnapshot } from "./types";

export function parseAnalyticsAccount(payload: unknown): CreditSnapshot["account"] {
  const source = payload as { user?: { email?: unknown; name?: unknown }; actor?: { email?: unknown; name?: unknown } } | null;
  const user = source?.actor ?? source?.user;
  if (typeof user?.email !== "string" || !user.email.trim()) return undefined;
  return { email: user.email.trim(), ...(typeof user.name === "string" ? { name: user.name } : {}) };
}

export interface CodexAdminIdentity {
  workspaceId: string;
  userId: string;
}

export interface AnalyticsRequestOptions {
  credentials: "include";
  redirect: "manual";
  cache: "no-store";
  headers: Record<string, string>;
  signal: AbortSignal;
}

export type AnalyticsFetcher = (url: string, options: AnalyticsRequestOptions) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export async function fetchCreditSnapshot(
  identity: CodexAdminIdentity,
  fetcher: AnalyticsFetcher,
  now = new Date(),
): Promise<CreditSnapshot> {
  let account: CreditSnapshot["account"];
  const readJson = async (url: string, headers: Record<string, string>) => {
    const response = await fetcher(url, {
      credentials: "include",
      redirect: "manual",
      cache: "no-store",
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 403) return { accessDenied: true };
    if (response.status === 401
      || (response.status >= 300 && response.status < 400)) return { authRequired: true };
    if (response.status !== 200) throw new Error(`Analytics request failed (${response.status})`);
    if (!response.headers.get("content-type")?.includes("application/json")) return { authRequired: true };
    return { payload: await response.json() };
  };
  try {
    const bootstrapUrl = new URL("https://admin.openai.com/api/csr/bootstrap");
    bootstrapUrl.searchParams.set("workspace_id", identity.workspaceId);
    bootstrapUrl.searchParams.set("workspace_directory", "deferred");
    const bootstrap = await readJson(bootstrapUrl.toString(), {});
    if (bootstrap.accessDenied) return { status: "access_denied", days: [], message: "This account cannot access credit analytics" };
    if (bootstrap.authRequired) return { status: "auth_required", days: [] };
    account = parseAnalyticsAccount(bootstrap.payload);
    const details = bootstrap.payload as {
      user?: { id?: unknown; currentTenantId?: unknown; canShowCreditAnalytics?: unknown };
      actor?: { id?: unknown };
      tenant?: { id?: unknown };
      scope?: { workspaceId?: unknown };
      roleCapabilities?: { admin?: unknown; owner?: unknown; analytics?: unknown; codexAnalytics?: unknown };
    } | null;
    const user = details?.user;
    if (user?.canShowCreditAnalytics === false) {
      return { status: "access_denied", days: [], account, message: "This account cannot access credit analytics" };
    }
    const userId = details?.actor?.id ?? user?.id;
    const tenantId = details?.tenant?.id ?? user?.currentTenantId;
    if (typeof userId !== "string" || !userId || typeof tenantId !== "string" || !tenantId) {
      return { status: "auth_required", days: [], account };
    }
    if (details?.scope?.workspaceId !== identity.workspaceId) {
      throw new Error("Analytics permission response belongs to a different workspace");
    }
    const permissions = details?.roleCapabilities;
    if (!permissions) throw new Error("Could not verify analytics permissions");
    if (![permissions.admin, permissions.owner, permissions.analytics, permissions.codexAnalytics].some(value => value === true)) {
      return { status: "access_denied", days: [], account, message: "This account cannot access credit analytics" };
    }
    const credits = await readJson(buildCreditsDataUrl(identity, now), {
      "x-admin-portal-client": "csr",
      "x-admin-portal-tenant": tenantId,
      "x-admin-portal-user": userId,
      "x-admin-portal-workspace-id": identity.workspaceId,
    });
    if (credits.accessDenied) return { status: "access_denied", days: [], account, message: "This account cannot access credit analytics" };
    if (credits.authRequired) return { status: "auth_required", days: [], account };
    return { status: "ready", days: parseCreditDays(credits.payload), account, updatedAt: now.toISOString() };
  } catch (error) {
    return { status: "error", days: [], account, message: error instanceof Error ? error.message : "Credits request failed" };
  }
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
