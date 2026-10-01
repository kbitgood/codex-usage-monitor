import { describe, expect, test } from "bun:test";
import { exhaustedWindowKey } from "../src/auto-reset";

const window = { used_percent: 100, window_minutes: 10_080, resets_at: 2_000 };
const now = 1_000_000;

describe("automatic reset eligibility", () => {
  test("requires a live applicable credit and an exhausted, unexpired window", () => {
    expect(exhaustedWindowKey({ secondary: window, bankedResets: 1, applicableBankedResets: 1 }, now))
      .toBe("10080:2000");
    expect(exhaustedWindowKey({ secondary: { ...window, used_percent: 99 }, bankedResets: 1, applicableBankedResets: 1 }, now))
      .toBeUndefined();
    expect(exhaustedWindowKey({ secondary: window, bankedResets: 1, applicableBankedResets: 0 }, now))
      .toBeUndefined();
    expect(exhaustedWindowKey({ secondary: window, bankedResets: 0, applicableBankedResets: 1 }, now))
      .toBeUndefined();
    expect(exhaustedWindowKey({ secondary: window, bankedResets: 1, applicableBankedResets: 1 }, 2_000_000))
      .toBeUndefined();
  });
});
