import { describe, expect, test } from "bun:test";
import {
  buildCreditsDataUrl,
  parseCodexAdminIdentity,
  parseCreditDays,
  parseAnalyticsAccount,
  fetchCreditSnapshot,
  type AnalyticsRequestOptions,
} from "../src/credits";

function token(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("credits data", () => {
  test("reads the analytics browser account without retaining session credentials", () => {
    expect(parseAnalyticsAccount({ user: {
      email: "viewer@example.com", name: "Analytics viewer", id: "browser-user", access_token: "secret",
    } })).toEqual({ email: "viewer@example.com", name: "Analytics viewer" });
    expect(parseAnalyticsAccount({ user: { email: " viewer@example.com " } })).toEqual({ email: "viewer@example.com" });
  });

  test("does not label an unrelated Codex login as the analytics browser account", () => {
    expect(parseAnalyticsAccount({ tokens: { id_token: "codex-token" }, email: "cli@example.com" })).toBeUndefined();
    expect(parseAnalyticsAccount(null)).toBeUndefined();
    expect(parseAnalyticsAccount({ user: { email: " " } })).toBeUndefined();
  });

  test("reads the workspace and user from Codex auth", () => {
    const auth = JSON.stringify({
      tokens: {
        id_token: token({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "workspace-123",
            chatgpt_user_id: "user-123",
          },
        }),
      },
    });

    expect(parseCodexAdminIdentity(auth)).toEqual({
      workspaceId: "workspace-123",
      userId: "user-123",
    });
  });

  test("keeps the latest seven daily Codex credit buckets", () => {
    const points = Array.from({ length: 9 }, (_, index) => ({
      bucket_start: `2026-08-${String(index + 1).padStart(2, "0")}`,
      value: index * 10.5,
      is_partial: index === 8,
    }));
    const days = parseCreditDays({
      charts: {
        credits: {
          series: [
            { dimensions: { product: "chatgpt" }, points: [] },
            { dimensions: { product: "codex" }, points },
          ],
        },
      },
    });

    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ date: "2026-08-03", credits: 21, partial: false });
    expect(days.at(-1)).toEqual({ date: "2026-08-09", credits: 84, partial: true });
  });

  test("uses the product filters accepted by the current Admin Console API", () => {
    const url = new URL(buildCreditsDataUrl(
      { workspaceId: "workspace-123", userId: "user-123" },
      new Date("2026-08-28T12:00:00Z"),
    ));

    expect(url.searchParams.getAll("products")).toEqual(["codex", "chatgpt"]);
    expect(url.searchParams.get("include_filter_metadata")).toBe("true");
  });
});

describe("session-only analytics requests", () => {
  const identity = { workspaceId: "workspace-123", userId: "monitored-user" };
  const bootstrap = { actor: { id: "browser-user", email: "viewer@example.com" }, tenant: { id: "tenant-123" }, scope: { workspaceId: "workspace-123" }, roleCapabilities: { analytics: true } };
  const json = (payload: unknown, status = 200) => Response.json(payload, { status });

  test("fetches credits using saved-session credentials and the browser account", async () => {
    const calls: Array<{ url: string; options: AnalyticsRequestOptions }> = [];
    const snapshot = await fetchCreditSnapshot(identity, async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? json(bootstrap) : json({ charts: { credits: { series: [{
        dimensions: { product: "codex" }, points: [{ bucket_start: "2026-10-13", value: 42, is_partial: true }],
      }] } } });
    }, new Date("2026-10-13T12:00:00Z"));
    expect(snapshot.status).toBe("ready");
    expect(snapshot.account).toEqual({ email: "viewer@example.com" });
    expect(snapshot.days).toEqual([{ date: "2026-10-13", credits: 42, partial: true }]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("workspace_id")).toBe("workspace-123");
    for (const { url, options } of calls) {
      expect(new URL(url).origin).toBe("https://admin.openai.com");
      expect(options.credentials).toBe("include");
      expect(options.redirect).toBe("manual");
      expect(options.cache).toBe("no-store");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[1]?.options.headers["x-admin-portal-user"]).toBe("browser-user");
    expect(calls[1]?.options.headers["x-admin-portal-tenant"]).toBe("tenant-123");
    expect(new URL(calls[1]!.url).searchParams.get("user_ids")).toBe("monitored-user");
  });

  for (const status of [302, 401, 403]) {
    test(`handles bootstrap ${status} without requesting credits`, async () => {
      let calls = 0;
      const result = await fetchCreditSnapshot(identity, async () => { calls++; return new Response(null, { status }); });
      expect(result.status).toBe(status === 403 ? "access_denied" : "auth_required");
      expect(result.days).toEqual([]);
      expect(calls).toBe(1);
    });
  }

  test("requires reconnecting when the saved session returns a login page", async () => {
    const result = await fetchCreditSnapshot(identity, async () => new Response("Sign in", { headers: { "content-type": "text/html" } }));
    expect(result.status).toBe("auth_required");
    expect(result.days).toEqual([]);
  });

  test("retains the browser account when credit analytics access is denied", async () => {
    let calls = 0;
    const result = await fetchCreditSnapshot(identity, async () => ++calls === 1 ? json(bootstrap) : new Response(null, { status: 403 }));
    expect(result.status).toBe("access_denied");
    expect(result.account?.email).toBe("viewer@example.com");
    expect(result.days).toEqual([]);
  });

  test("does not borrow a Codex identity when the browser session lacks tenant information", async () => {
    let calls = 0;
    const result = await fetchCreditSnapshot(identity, async () => { calls++; return json({ user: { email: "viewer@example.com" } }); });
    expect(result.status).toBe("auth_required");
    expect(calls).toBe(1);
  });

  test("reports network and server failures without manufacturing credit data", async () => {
    const offline = await fetchCreditSnapshot(identity, async () => { throw new Error("Offline"); });
    expect(offline.status).toBe("error");
    expect(offline.days).toEqual([]);
    const serverError = await fetchCreditSnapshot(identity, async () => new Response(null, { status: 500 }));
    expect(serverError.status).toBe("error");
    expect(serverError.days).toEqual([]);
  });
});

test("revoked analytics permission hides credits even if a cached credits endpoint would allow them", async () => {
  let calls = 0;
  const snapshot = await fetchCreditSnapshot({ workspaceId: "workspace-123", userId: "monitored-user" }, async () => {
    calls++;
    return Response.json({ actor: { id: "browser-user", email: "viewer@example.com" }, tenant: { id: "tenant-123" }, scope: { workspaceId: "workspace-123" }, roleCapabilities: { admin: false, owner: false, analytics: false, codexAnalytics: false, endUserView: true }, workspaceAccess: { canShowCreditAnalytics: true } });
  });
  expect(snapshot.status).toBe("access_denied");
  expect(snapshot.account?.email).toBe("viewer@example.com");
  expect(snapshot.days).toEqual([]);
  expect(calls).toBe(1);
});

test("does not display credits if workspace permissions are missing or belong to another workspace", async () => {
  const identity = { workspaceId: "workspace-123", userId: "monitored-user" };
  for (const extra of [{}, { roleCapabilities: { analytics: true }, scope: { workspaceId: "another-workspace" } }]) {
    let calls = 0;
    const result = await fetchCreditSnapshot(identity, async () => {
      calls++;
      return Response.json({ actor: { id: "browser-user", email: "viewer@example.com" }, tenant: { id: "tenant-123" }, ...extra });
    });
    expect(result.status).toBe("error");
    expect(result.days).toEqual([]);
    expect(calls).toBe(1);
  }
});
