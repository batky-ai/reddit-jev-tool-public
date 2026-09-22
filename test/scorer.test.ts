import { describe, expect, it, vi } from "vitest";
import { assessKey, cacheKey, createScorer, type KV } from "../src/background/scorer";
import type { JevResponse } from "../src/jev/client";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { Card, FeedPost, Settings } from "../src/shared/types";
import { fixture } from "./fixture";

const recorded = JSON.parse(fixture("jev-tier1-response.json")) as JevResponse;
const memory = (): KV & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
};
const post = { id: "p1", title: "t", body: "", permalink: "/x", subreddit: "n8n", commentCount: 0, createdAt: null, author: "", flair: "" } as FeedPost;
const cards: Card[] = [{ id: "n8n", title: "n8n", summary: "s", keywords: ["n8n"] }];

function setup(settings: Partial<Settings> = {}, now = Date.parse("2026-09-21T12:00:00Z")) {
  const clock = { now };
  const jev = vi.fn(async () => recorded);
  const deps = {
    cache: memory(),
    counters: memory(),
    loadSettings: async () => ({ ...DEFAULT_SETTINGS, apiKey: "k", ...settings }),
    jev,
    now: () => clock.now,
  };
  return { scorer: createScorer(deps), deps, jev, clock };
}

describe("scorer", () => {
  it("scores once, then serves the cache", async () => {
    const { scorer, jev } = setup();
    const a = await scorer.score(post, cards);
    const b = await scorer.score(post, cards);
    expect(a).toMatchObject({ ok: true, cached: false });
    expect(b).toMatchObject({ ok: true, cached: true });
    expect(jev).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent requests for the same post", async () => {
    const { scorer, jev } = setup();
    await Promise.all([scorer.score(post, cards), scorer.score(post, cards)]);
    expect(jev).toHaveBeenCalledTimes(1);
  });

  it("re-scores when the candidate cards change or the cache expires", async () => {
    const { scorer, jev, clock } = setup();
    await scorer.score(post, cards);
    await scorer.score(post, [{ ...cards[0]!, summary: "a longer summary" }]);
    expect(jev).toHaveBeenCalledTimes(2);
    clock.now += 7 * 3_600_000;
    await scorer.score(post, cards);
    expect(jev).toHaveBeenCalledTimes(3);
  });

  it("stops at the daily cap and resets on the next UTC day", async () => {
    const { scorer, jev, clock } = setup({ dailyCallCap: 1 });
    await scorer.score(post, cards);
    const blocked = await scorer.score({ ...post, id: "p2" }, cards);
    expect(blocked).toMatchObject({ ok: false, retryable: false });
    clock.now += 24 * 3_600_000;
    await expect(scorer.score({ ...post, id: "p2" }, cards)).resolves.toMatchObject({ ok: true });
    expect(jev).toHaveBeenCalledTimes(2);
  });

  it("reports a missing key without calling Jev or spending budget", async () => {
    const { scorer, jev, deps } = setup({ apiKey: "" });
    await expect(scorer.score(post, cards)).resolves.toMatchObject({ ok: false, retryable: false });
    expect(jev).not.toHaveBeenCalled();
    expect(deps.counters.data.size).toBe(0);
  });

  it("keys the cache by model", () => {
    expect(cacheKey("p1", cards, "jev-1.13.0")).not.toBe(cacheKey("p1", cards, "jev-latest"));
  });

  it("assesses a preview once per comment set and shares the daily cap", async () => {
    const tier2 = JSON.parse(fixture("jev-tier2-responses.json")).open;
    const { scorer, jev } = setup({ dailyCallCap: 2 });
    jev.mockResolvedValue(tier2);
    const comments = [{ id: "c", body: "b", score: 1, isOp: true, replyCount: 0 }];
    const first = await scorer.assess(post, comments, cards);
    expect(first).toMatchObject({ ok: true, cached: false });
    await expect(scorer.assess(post, comments, cards)).resolves.toMatchObject({ ok: true, cached: true });
    await scorer.assess(post, [...comments, { id: "d", body: "x", score: 0, isOp: false, replyCount: 0 }], cards);
    expect(jev).toHaveBeenCalledTimes(2);
    await expect(scorer.score(post, cards)).resolves.toMatchObject({ ok: false, retryable: false });
  });

  it("keys tier 2 separately from tier 1", () => {
    expect(assessKey("p1", [], [], "m")).not.toBe(cacheKey("p1", [], "m"));
  });

  it("re-judges a preview when the cards change", () => {
    const comments = [{ id: "c", body: "b", score: 1, isOp: false, replyCount: 0 }];
    expect(assessKey("p1", comments, cards, "m")).not.toBe(assessKey("p1", comments, [{ ...cards[0]!, summary: "longer summary" }], "m"));
  });
});

