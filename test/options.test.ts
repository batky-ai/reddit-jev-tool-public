// @vitest-environment jsdom
// Runs the real options page script against the real options.html with
// chrome.storage stubbed: the first thing a new user touches.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve(process.cwd(), "static/options.html"), "utf8");
const settle = () => new Promise((r) => setTimeout(r, 20));
let store: Record<string, unknown>;

beforeEach(async () => {
  vi.resetModules();
  store = {
    settings: { threshold: 0.7, apiKey: "existing-key" },
    jevCalls: { day: new Date().toISOString().slice(0, 10), count: 12 },
    learned: { thresholdDelta: -0.05, subredditOffsets: { n8n: -0.1 }, keywordWeights: { "n8n::webhook": 1.25 }, labelled: 9, updatedAt: 1 },
    feedback: [{ action: "answered" }, { action: "skipped" }],
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: structuredClone(store[k]) }),
        set: async (o: Record<string, unknown>) => void Object.assign(store, structuredClone(o)),
        remove: async (k: string | string[]) => void [k].flat().forEach((key) => delete store[key]),
      },
      onChanged: { addListener: () => {} },
    },
  };
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, "");
  await import("../src/options/index");
  await settle();
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

describe("options page", () => {
  it("renders stored settings, defaults, usage and the learning summary", () => {
    expect($<HTMLInputElement>("apiKey").value).toBe("existing-key");
    expect($<HTMLInputElement>("threshold").value).toBe("0.7");
    expect($<HTMLInputElement>("maxComments").value).toBe("40");
    expect(document.getElementById("maxAgeHours")).toBeNull();
    expect(document.querySelector<HTMLInputElement>("input[name=subredditMode][value=all]")!.checked).toBe(true);
    expect($("usage").textContent).toBe("Jev calls today (UTC): 12 of 500");
    const summary = $("learning-summary").textContent!;
    expect(summary).toContain("Labelled posts: 9");
    expect(summary).toContain("r/n8n -0.1");
    expect(summary).toContain("webhook 1.25");
  });

  it("saves a changed threshold, subreddit list and mode", async () => {
    $<HTMLInputElement>("threshold").value = "0.55";
    $<HTMLInputElement>("threshold").dispatchEvent(new Event("change"));
    await settle();
    $<HTMLTextAreaElement>("subreddits").value = "r/n8n, ClaudeCode shopify";
    const only = document.querySelector<HTMLInputElement>("input[name=subredditMode][value=only]")!;
    only.checked = true;
    only.dispatchEvent(new Event("change"));
    await settle();
    expect(store.settings).toMatchObject({ threshold: 0.55, subredditMode: "only", subreddits: ["n8n", "claudecode", "shopify"], apiKey: "existing-key" });
  });

  it("saves markdown cards and reports keyword-less ones", async () => {
    $<HTMLTextAreaElement>("cards").value = "## n8n\nkeywords: n8n, webhook\nBuilds workflows.\n\n## Bare card\nNo keywords here.";
    $("cards-save").click();
    await settle();
    expect((store.cards as Array<{ id: string }>).map((c) => c.id)).toEqual(["n8n", "bare-card"]);
    expect($("cards-status").textContent).toContain("Saved 2 cards. No keywords on: Bare card.");
  });

  it("resets learning after confirmation, keeping cards and settings", async () => {
    vi.stubGlobal("confirm", () => true);
    $("learning-reset").click();
    await settle();
    expect(store.feedback).toBeUndefined();
    expect(store.learned).toBeUndefined();
    expect(store.settings).toBeDefined();
    expect($("learning-summary").textContent).toContain("Labelled posts: 0");
  });
});
