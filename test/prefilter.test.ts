import { describe, expect, it } from "vitest";
import { containsKeyword, helpSignal, prefilter, rankCards } from "../src/core/prefilter";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { Card, FeedPost } from "../src/shared/types";

const NOW = Date.parse("2026-09-21T20:00:00Z");
const post = (o: Partial<FeedPost> = {}): FeedPost => ({
  id: "p1",
  title: "How do I retry a failed n8n webhook?",
  body: "",
  permalink: "/r/n8n/comments/p1/x/",
  subreddit: "n8n",
  commentCount: 2,
  createdAt: NOW - 3_600_000,
  author: "a",
  flair: "",
  ...o,
});
const cards: Card[] = [
  { id: "n8n", title: "n8n", summary: "n8n workflows", keywords: ["n8n", "webhook"] },
  { id: "shopify", title: "Shopify", summary: "Shopify themes", keywords: ["shopify", "liquid"] },
];

describe("helpSignal", () => {
  it("recognizes questions, openers, flair and help wording", () => {
    expect(helpSignal({ title: "Anyone using X?", body: "", flair: "" }).reasons).toEqual(
      expect.arrayContaining(["question mark", "question opener"]),
    );
    expect(helpSignal({ title: "Webhook timing out", body: "", flair: "Help" }).isLikelyHelp).toBe(true);
    expect(helpSignal({ title: "Workflow keeps failing after update", body: "", flair: "" }).isLikelyHelp).toBe(true);
  });

  it("does not flag showcase posts", () => {
    expect(helpSignal({ title: "I built a dashboard for my team", body: "Here it is.", flair: "Showcase" }).isLikelyHelp).toBe(false);
  });
});

describe("keywords", () => {
  it("matches whole words and phrases only", () => {
    expect(containsKeyword("using n8n cloud", "n8n")).toBe(true);
    expect(containsKeyword("theme.liquid file", "liquid")).toBe(true);
    expect(containsKeyword("liquidity pools", "liquid")).toBe(false);
    expect(containsKeyword("the Order Webhook broke", "order webhook")).toBe(true);
  });

  it("ranks by learned weights and drops zero-weight cards", () => {
    const p = { title: "n8n and shopify", body: "" };
    expect(rankCards(p, cards).map((m) => m.card.id)).toEqual(["n8n", "shopify"].filter((id) => id !== "x"));
    expect(rankCards(p, cards, { "shopify::shopify": 3 })[0]!.card.id).toBe("shopify");
    expect(rankCards(p, cards, { "n8n::n8n": 0 }).map((m) => m.card.id)).toEqual(["shopify"]);
  });
});

describe("prefilter", () => {
  const s = DEFAULT_SETTINGS;

  it("passes a fresh help request with keyword overlap and returns matching cards first", () => {
    const r = prefilter(post(), cards, s, { now: NOW });
    expect(r.pass).toBe(true);
    expect(r.candidates.map((c) => c.id)).toEqual(["n8n"]);
  });

  it("keeps passing subreddit-only matches even after learning zeroed the keyword", () => {
    const p = post({ title: "Need some help creating a message workflow", body: "", subreddit: "n8n" });
    expect(prefilter(p, cards, DEFAULT_SETTINGS, { now: NOW, weights: { "n8n::n8n": 0 } }).pass).toBe(true);
  });

  it.each([
    ["disabled", post(), { ...s, enabled: false }],
    ["subreddit", post(), { ...s, subredditMode: "only" as const, subreddits: ["shopify"] }],
    ["archived", post({ createdAt: NOW - 200 * 24 * 3_600_000 }), s],
    ["too many comments", post({ commentCount: 500 }), s],
    ["not a help request", post({ title: "Look at my n8n dashboard" }), s],
    ["no card overlap", post({ title: "How do I fix my bike chain?", subreddit: "bicycling" }), s],
  ])("rejects: %s", (reason, p, settings) => {
    expect(prefilter(p, cards, settings, { now: NOW }).rejection).toBe(reason);
  });

  it("accepts r/ prefixes and case in the subreddit allowlist", () => {
    const r = prefilter(post({ subreddit: "N8N" }), cards, { ...s, subredditMode: "only", subreddits: ["r/n8n"] }, { now: NOW });
    expect(r.pass).toBe(true);
  });

  it("scores without keywords only when the user opts in", () => {
    const p = post({ title: "How do I fix my bike chain?", subreddit: "bicycling" });
    const r = prefilter(p, cards, { ...s, scoreWithoutKeywords: true }, { now: NOW });
    expect(r.pass).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  it("rejects when the user has no cards", () => {
    expect(prefilter(post(), [], s, { now: NOW }).rejection).toBe("no cards");
  });
});

describe("subreddit as context", () => {
  it("matches a card by the subreddit name when the post does not name the tool", () => {
    const p = post({ title: "Need some help creating a message workflow", body: "", subreddit: "n8n" });
    const r = prefilter(p, cards, DEFAULT_SETTINGS, { now: NOW });
    expect(r.pass).toBe(true);
    expect(r.candidates.map((c) => c.id)).toEqual(["n8n"]);
    expect(r.hits).toEqual([]); // nothing to learn from: the post never named the tool
  });

  it("does not match unrelated subreddits", () => {
    const p = post({ title: "Need some help creating a message workflow", body: "", subreddit: "cooking" });
    expect(prefilter(p, cards, DEFAULT_SETTINGS, { now: NOW }).rejection).toBe("no card overlap");
  });
});

describe("no age limit", () => {
  it("passes old but not archived posts to Jev, whatever an old saved maxAgeHours says", () => {
    const old = post({ createdAt: NOW - 30 * 24 * 3_600_000 });
    const legacy = { ...DEFAULT_SETTINGS, maxAgeHours: 72 } as typeof DEFAULT_SETTINGS;
    expect(prefilter(old, cards, legacy, { now: NOW }).pass).toBe(true);
  });
});
