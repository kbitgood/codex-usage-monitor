import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { CreditSnapshot } from "../src/types";

const source = readFileSync(new URL("../ui/widget.js", import.meta.url), "utf8");

class Element {
  hidden = false;
  listeners = new Map<string, () => unknown>();
  textContent = "";
  children: Element[] = [];
  style = { setProperty() {} };
  classes = new Set<string>();
  classList = {
    toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
    remove: (name: string) => this.classes.delete(name),
    add: (name: string) => this.classes.add(name),
  };
  elements = new Map<string, Element>();
  querySelector(selector: string): Element {
    if (!this.elements.has(selector)) this.elements.set(selector, new Element());
    return this.elements.get(selector)!;
  }
  addEventListener(event: string, handler: () => unknown) { this.listeners.set(event, handler); }
  setAttribute() {}
  replaceChildren(...children: Element[]) { this.children = children; }
  append(...children: Element[]) { this.children.push(...children); }
}

async function widget(initial: CreditSnapshot, compact = false) {
  let credits = initial;
  let fail = false;
  let settingChanged: (enabled: boolean) => void = () => {};
  let savedSetting = false;
  const document = Object.assign(new Element(), {
    body: new Element(), documentElement: new Element(), createElement: () => new Element(),
  });
  const window = {
    innerWidth: 340, innerHeight: 324, addEventListener() {},
    codexMonitor: {
      latest: async () => ({ rateLimits: {
        primary: { used_percent: 10, resets_at: Date.now() / 1000 + 3600 },
        secondary: compact ? null : { used_percent: 20, resets_at: Date.now() / 1000 + 7200 },
      } }),
      latestCredits: async () => { if (fail) throw new Error("Offline"); return credits; },
      automaticallyUseResets: async () => savedSetting,
      onAutomaticallyUseResetsChanged(callback: (enabled: boolean) => void) { settingChanged = callback; }, onRefresh() {}, hide() {}, setCompact() {},
    },
  };
  const context = createContext({ document, window, requestAnimationFrame: (fn: () => void) => fn(),
    setTimeout() {}, clearTimeout() {}, setInterval() {},
  });
  runInContext(source, context);
  await runInContext("refresh()", context);
  await runInContext("refreshCredits()", context);
  return {
    section: document.querySelector(".credits"), chart: document.querySelector("#credit-chart"),
    height: () => runInContext("baseWidgetHeight", context),
    refresh: async (next: CreditSnapshot, reject = false) => {
      credits = next; fail = reject; await runInContext("refreshCredits()", context);
    },
  };
}

for (const status of ["auth_required", "unavailable", "error"] as const) {
  test(`hides credit bars and shrinks when analytics are ${status}`, async () => {
    const view = await widget({ status, days: [] });
    expect(view.section.hidden).toBe(true);
    expect(view.chart.children).toHaveLength(0);
    expect(view.height()).toBe(212);
  });
}

test("shows actual analytics, clears stale bars on lost access, and restores them on reconnect", async () => {
  const ready: CreditSnapshot = { status: "ready", days: [] };
  const view = await widget(ready, true);
  expect(view.section.hidden).toBe(false);
  expect(view.chart.children).toHaveLength(7);
  expect(view.height()).toBe(254);
  await view.refresh({ status: "auth_required", days: [] });
  expect(view.section.hidden).toBe(true);
  expect(view.chart.children).toHaveLength(0);
  expect(view.height()).toBe(142);
  await view.refresh(ready);
  expect(view.section.hidden).toBe(false);
  expect(view.chart.children).toHaveLength(7);
  await view.refresh(ready, true);
  expect(view.section.hidden).toBe(true);
  expect(view.chart.children).toHaveLength(0);
});
