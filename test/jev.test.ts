import { describe, expect, it, vi } from "vitest";
import { JevError, boostedMatch, buildTier1Request, buildTier2Request, callJev, parseTier1, parseTier2, tierFor, type JevResponse } from "../src/jev/client";
import type { Card, FeedPost } from "../src/shared/types";
import { fixture } from "./fixture";

const recorded = JSON.parse(fixture("jev-tier1-response.json")) as JevResponse;
const post: FeedPost = {
  id: "p1",
  title: "Webhook node never fires",
  body: "x".repeat(5000),
  permalink: "/r/n8n/comments/p1/x/",
  subreddit: "n8n",
  commentCount: 1,
  createdAt: null,
  author: "zq_author_77",
  flair: "",
};
const cards: Card[] = [
  { id: "n8n", title: "n8n cloud workflows", summary: "s", keywords: ["n8n"] },
  { id: "shopify-webhooks", title: "Shopify webhooks", summary: "s", keywords: ["shopify"] },
];

describe("buildTier1Request", () => {
  const req = buildTier1Request(post, cards, "jev-1.13.0");

  it("pins the model, caps the body and never sends the author", () => {
    expect(req.model).toBe("jev-1.13.0");
    expect(req.state.post.body).toHaveLength(2000);
    expect(JSON.stringify(req)).not.toContain("zq_author_77");
  });

  it("offers every candidate card plus none as choices, and five match levels", () => {
    expect(Object.keys(req.questions.best_card.criteria)).toEqual(["n8n", "shopify-webhooks", "none"]);
    expect(req.questions.expertise_match.criteria).toHaveLength(5);
  });
});

describe("parseTier1", () => {
  it("normalizes the recorded live response", () => {
    const v = parseTier1("p1", recorded, 42);
    expect(v).toMatchObject({ postId: "p1", helpProb: 0.97, bestCard: "n8n", bestCardProb: 0.7, model: "jev-1.13.0", inputTokens: 645, scoredAt: 42 });
    expect(v.match).toBeCloseTo(3.88 / 4);
  });

  it("maps a none choice to no card", () => {
    const res = structuredClone(recorded);
    (res.answers.best_card as { choice: string }).choice = "none";
    expect(parseTier1("p1", res).bestCard).toBeNull();
  });

  it("rejects a response missing an answer", () => {
    const res = structuredClone(recorded);
    delete res.answers.expertise_match;
    expect(() => parseTier1("p1", res)).toThrow(JevError);
  });
});

describe("tierFor", () => {
  it.each([
    [{ helpProb: 0.3, match: 1 }, "none"],
    [{ helpProb: 0.9, match: 0.9 }, "strong"],
    [{ helpProb: 0.9, match: 0.65 }, "good"],
    [{ helpProb: 0.9, match: 0.5 }, "maybe"],
    [{ helpProb: 0.9, match: 0.2 }, "none"],
  ])("%o -> %s at threshold 0.6", (v, tier) => {
    expect(tierFor(v, 0.6)).toBe(tier);
  });
});

describe("callJev", () => {
  const ok = () => new Response(JSON.stringify(recorded), { status: 200 });
  const sleep = vi.fn(async () => {});

  it("sends a bearer key and returns the parsed body", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await expect(callJev("k", { a: 1 }, { fetchImpl, sleep })).resolves.toEqual(recorded);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("retries 429 and 529 with backoff, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(ok());
    await expect(callJev("k", {}, { fetchImpl, sleep })).resolves.toEqual(recorded);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401 or 422", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad key", { status: 401 }));
    await expect(callJev("k", {}, { fetchImpl, sleep })).rejects.toMatchObject({ retryable: false, status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to call without a key", async () => {
    const fetchImpl = vi.fn();
    await expect(callJev("", {}, { fetchImpl, sleep })).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("tier 2", () => {
  const recorded2 = JSON.parse(fixture("jev-tier2-responses.json")) as Record<string, JevResponse>;
  const comments = [
    { id: "a", body: "Use the production URL.", score: 14, isOp: false, replyCount: 1 },
    { id: "b", body: "That fixed it.", score: 6, isOp: true, replyCount: 0 },
  ];

  it("sends numbered comments without ids or authors, the cards, and one gap question per comment", () => {
    const req = buildTier2Request(post, comments, cards, "jev-1.13.0");
    expect(req.state.comments).toEqual([
      { number: 0, from_original_poster: false, score: 14, replies: 1, text: "Use the production URL." },
      { number: 1, from_original_poster: true, score: 6, replies: 0, text: "That fixed it." },
    ]);
    expect(req.state.expertise_cards.map((c) => c.id)).toEqual(["n8n", "shopify-webhooks"]);
    expect(Object.keys(req.questions)).toEqual(["gap_0", "gap_1", "already_well_answered", "op_still_needs_help"]);
    expect((req.questions as Record<string, { type: string }>).gap_1!.type).toBe("noul");
    expect(JSON.stringify(req)).not.toContain("zq_author_77");
    expect(JSON.stringify(req)).not.toMatch(/"id":"[ab]"/);
  });

  it("asks no gap questions when there are no comments", () => {
    expect(Object.keys(buildTier2Request(post, [], cards, "m").questions)).toEqual(["already_well_answered", "op_still_needs_help"]);
  });

  it("parses the recorded live responses, mapping gap probabilities back to comment ids", () => {
    expect(parseTier2("p1", recorded2.answered!).answeredProb).toBeGreaterThan(0.8);
    expect(parseTier2("p1", recorded2.open!).stillNeedsProb).toBeGreaterThan(0.8);
    const v = parseTier2("p1", recorded2.withValue!, ["k1", "k2", "k3", "k4"]);
    expect(v.valueProbs.k2).toBeGreaterThanOrEqual(0.8);
    expect(v.valueProbs.k1).toBeLessThan(0.8);
    expect(v.valueProbs.k4).toBeLessThan(0.2);
    expect(parseTier2("p1", recorded2.open!, ["x"]).valueProbs).toEqual({});
  });
});

describe("boostedMatch", () => {
  it("adds the full boost at 0 comments and half at 1 or 2", () => {
    expect(boostedMatch(0.55, 0, 0.6, 0.1)).toBeCloseTo(0.65);
    expect(boostedMatch(0.55, 2, 0.6, 0.1)).toBeCloseTo(0.6);
    expect(boostedMatch(0.55, 3, 0.6, 0.1)).toBe(0.55);
  });

  it("never lifts posts outside your area, never exceeds 1, and can be turned off", () => {
    expect(boostedMatch(0.3, 0, 0.6, 0.1)).toBe(0.3);
    expect(boostedMatch(0.98, 0, 0.6, 0.1)).toBe(1);
    expect(boostedMatch(0.55, 0, 0.6, 0)).toBe(0.55);
  });

  it("can promote an unanswered maybe to a good match", () => {
    expect(tierFor({ helpProb: 0.9, match: 0.55 }, 0.6)).toBe("maybe");
    expect(tierFor({ helpProb: 0.9, match: boostedMatch(0.55, 0, 0.6, 0.1) }, 0.6)).toBe("good");
  });
});

describe("isUnansweredOpFollowUp", () => {
  it("flags OP questions nobody replied to, only", async () => {
    const { isUnansweredOpFollowUp } = await import("../src/content/preview");
    expect(isUnansweredOpFollowUp({ isOp: true, replyCount: 0, body: "Thanks! How do I verify the HMAC though?" })).toBe(true);
    expect(isUnansweredOpFollowUp({ isOp: true, replyCount: 1, body: "How do I verify the HMAC though?" })).toBe(false);
    expect(isUnansweredOpFollowUp({ isOp: false, replyCount: 0, body: "How do I verify the HMAC though?" })).toBe(false);
    expect(isUnansweredOpFollowUp({ isOp: true, replyCount: 0, body: "That worked, thanks everyone." })).toBe(false);
  });
});
