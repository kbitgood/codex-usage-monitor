import { describe, expect, test } from "bun:test";
import {
  buildCreditsDataUrl,
  parseCodexAdminIdentity,
  parseCreditDays,
} from "../src/credits";

function token(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("credits data", () => {
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
