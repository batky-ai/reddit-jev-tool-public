// @vitest-environment jsdom
// Thread mode against a synthetic thread page shaped like the live DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectCandidates, batches } from "../src/core/comments";
import { buildTier2Request } from "../src/jev/client";
import { COMMENT_SELECTOR, extractComment, replyButtonFor, threadPostId } from "../src/reddit/adapter";
import type { RedditClient } from "../src/reddit/client";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { AssessRequestMessage, Card } from "../src/shared/types";
import { fixture } from "./fixture";

const cards: Card[] = [
  { id: "n8n", title: "n8n workflows", summary: "s", keywords: ["n8n", "webhook"] },
  { id: "shopify", title: "Shopify webhooks", summary: "s", keywords: ["shopify", "hmac"] },
];
const comments = () => [...document.querySelectorAll(COMMENT_SELECTOR)].map((el) => extractComment(el)!);

beforeEach(() => {
  document.body.innerHTML = fixture("contract-thread.html");
});

describe("comment adapter", () => {
  it("reads id, parent, depth, body without nested replies, and flags", () => {
    const all = comments();
    const c3 = all.find((c) => c.id === "c3")!;
    expect(c3).toMatchObject({ author: "asker_b", depth: 0, parentId: null, score: 2, collapsed: false, moderator: false });
    expect(c3.body).toBe("Does this also work with Shopify Plus webhooks?");
    expect(all.find((c) => c.id === "c3r")).toMatchObject({ parentId: "c3", depth: 1 });
    expect(all.find((c) => c.id === "c4")!.moderator).toBe(true);
    expect(all.find((c) => c.id === "c5")!.collapsed).toBe(true);
  });

  it("finds the reply button of the comment itself, not of a nested reply", () => {
    const c3 = document.querySelector('shreddit-comment[thingid="t1_c3"]')!;
    expect(replyButtonFor(c3)?.closest("shreddit-comment-action-row")?.getAttribute("comment-id")).toBe("t1_c3");
    expect(replyButtonFor(document.querySelector('shreddit-comment[thingid="t1_c7"]')!)).toBeNull();
  });

  it("reads the post id from a thread or comment permalink URL", () => {
    expect(threadPostId("/r/n8n/comments/1wlt4oh/comment/pb1yes8/")).toBe("1wlt4oh");
    expect(threadPostId("/r/n8n/new/")).toBeNull();
  });
});

describe("selectCandidates", () => {
  it("keeps the OP follow-up first, drops mine, ones I replied under, mods, collapsed and noise", () => {
    const picked = selectCandidates(comments(), { me: "viewer_me", opAuthor: "op_person", cards });
    expect(picked.map((c) => c.comment.id)).toEqual(["c2", "c1"]);
    expect(picked[0]).toMatchObject({ isOp: true, opFollowUp: true, replyCount: 0 });
  });

  it("without a known user, keeps comments the user may have replied under", () => {
    const ids = selectCandidates(comments(), { me: null, opAuthor: "op_person", cards }).map((c) => c.comment.id);
    expect(ids).toContain("c3");
    expect(ids).toContain("c6");
  });

  it("batches at 15", () => {
    expect(batches(Array.from({ length: 32 }, (_, i) => i)).map((b) => b.length)).toEqual([15, 15, 2]);
  });
});

describe("scanThread", () => {
  let sent: AssessRequestMessage[];

  async function scan(
    settings = { ...DEFAULT_SETTINGS, apiKey: "k" },
    valueProbs: Record<string, number> = { c1: 0.8 },
    opts: { flush?: boolean; fail?: boolean } = { flush: true },
  ) {
    vi.resetModules();
    window.history.replaceState({}, "", "/r/n8n/comments/th1/webhook_never_fires/");
    sent = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { get: async (k: string) => ({ [k]: k === "settings" ? settings : k === "cards" ? cards : undefined }) }, onChanged: { addListener: () => {} } },
      runtime: { sendMessage: async () => ({}) },
    };
    class AllVisible {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        queueMicrotask(() => this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as never));
      }
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = AllVisible;
    const mod = await import("../src/content/thread");
    const client = { username: async () => "viewer_me" } as unknown as RedditClient;
    const stop = await mod.startThread(client);
    await new Promise((r) => setTimeout(r, 20));
    const deferred = vi.fn();
    const send = async (m: AssessRequestMessage) => {
      sent.push(m);
      return opts.fail
        ? ({ ok: false, error: "Daily Jev call cap of 500 reached", retryable: false } as const)
        : ({ ok: true, cached: false, verdict: { postId: "th1", answeredProb: 0, stillNeedsProb: 1, valueProbs, inputTokens: 1, scoredAt: 0 } } as const);
    };
    await mod.scanThread("viewer_me", send, { flush: opts.flush, onDeferred: deferred });
    stop();
    return { mod, send, deferred };
  }

  afterEach(() => document.getElementById("rjt-thread-pill")?.remove());

  it("flags the OP follow-up for free, sends the rest in one batch without authors, and marks Jev's pick", async () => {
    await scan();
    const badges = [...document.querySelectorAll(".rjt-comment-badge")];
    // Page order: c1 sits above c2.
    expect(badges.map((b) => [b.closest("shreddit-comment")!.getAttribute("thingid"), b.textContent])).toEqual([
      ["t1_c1", "Good place to reply 80% · reply ▸"],
      ["t1_c2", "OP follow-up unanswered · reply ▸"],
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.comments.map((c) => c.id)).toEqual(["c1"]);
    // What leaves the browser is the Jev request, which must carry no usernames.
    const jevBody = buildTier2Request(sent[0]!.post, sent[0]!.comments, sent[0]!.cards, "jev-1.13.0");
    expect(JSON.stringify(jevBody)).not.toMatch(/helper_a|op_person|viewer_me/);
    expect(jevBody.state.post.body).toBe("Shopify says delivered but the workflow never runs.");
    expect(sent[0]!.cards.map((c) => c.id)).toEqual(expect.arrayContaining(["n8n", "shopify"]));
    expect(document.getElementById("rjt-thread-pill")!.textContent).toBe("2 places you could help ▸ · checked 1 comment");
  });

  it("clicking a badge opens Reddit's reply box for that comment", async () => {
    await scan();
    const reply = replyButtonFor(document.querySelector('shreddit-comment[thingid="t1_c2"]')!)!;
    const clicked = vi.fn();
    reply.addEventListener("click", clicked);
    (document.querySelector('shreddit-comment[thingid="t1_c2"] .rjt-comment-badge') as HTMLButtonElement).click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("does nothing when thread scanning is off, and still flags OP follow-ups without a key", async () => {
    await scan({ ...DEFAULT_SETTINGS, apiKey: "k", scanThreads: false });
    expect(document.querySelectorAll(".rjt-comment-badge")).toHaveLength(0);

    document.body.innerHTML = fixture("contract-thread.html");
    await scan({ ...DEFAULT_SETTINGS, apiKey: "" });
    expect(sent).toHaveLength(0);
    expect(document.querySelectorAll(".rjt-comment-badge")).toHaveLength(1);
  });

  it("does not mark comments below the value threshold", async () => {
    await scan(undefined, { c1: 0.1 });
    expect(document.querySelectorAll(".rjt-comment-badge")).toHaveLength(1); // only the OP follow-up
  });

  it("holds a small trickle of candidates for the idle flush instead of spending a call", async () => {
    const { deferred } = await scan(undefined, { c1: 0.9 }, { flush: false });
    expect(sent).toHaveLength(0);
    expect(deferred).toHaveBeenCalledTimes(1);
    // The free OP follow-up is still flagged immediately.
    expect(document.querySelectorAll(".rjt-comment-badge")).toHaveLength(1);
  });

  it("keeps failed comments for a retry and shows the error in the pill", async () => {
    const { mod, send } = await scan(undefined, undefined, { flush: true, fail: true });
    expect(sent).toHaveLength(1);
    expect(document.getElementById("rjt-thread-pill")!.textContent).toContain("Jev: Daily Jev call cap of 500 reached");
    // Same thread, a later scan: c1 was not marked sent, so it is tried again.
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    await mod.scanThread("viewer_me", send, { flush: true });
    spy.mockRestore();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.comments.map((c) => c.id)).toEqual(["c1"]);
  });

  it("counts the budget in comments judged, so small batches cannot exhaust a thread", async () => {
    const { MAX_JUDGED_PER_THREAD } = await import("../src/content/thread");
    expect(MAX_JUDGED_PER_THREAD).toBeGreaterThanOrEqual(45);
  });

  it("gives the best comment of a batch a softer mark when nothing clears 0.8", async () => {
    document.querySelector('shreddit-comment[thingid="t1_c2"]')!.remove(); // no OP follow-up
    await scan(undefined, { c1: 0.71 });
    const b = document.querySelector('shreddit-comment[thingid="t1_c1"] .rjt-comment-badge') as HTMLElement;
    expect(b.textContent).toBe("Could add to this 71% · reply ▸");
    expect(b.dataset.kind).toBe("maybe");
  });

  it("shows the highest gap score when nothing reaches even the softer bar", async () => {
    document.querySelector('shreddit-comment[thingid="t1_c2"]')!.remove();
    await scan(undefined, { c1: 0.45 });
    expect(document.querySelectorAll(".rjt-comment-badge")).toHaveLength(0);
    expect(document.getElementById("rjt-thread-pill")!.textContent).toBe(
      "No open gaps found yet (highest 45%, bar 80%) · checked 1 comment",
    );
  });

  it("waits 30 seconds before re-sending after a failure", async () => {
    const { mod, send } = await scan(undefined, undefined, { flush: true, fail: true });
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 5_000);
    await mod.scanThread("viewer_me", send, { flush: true });
    expect(sent).toHaveLength(1);
    spy.mockReturnValue(now + 31_000);
    await mod.scanThread("viewer_me", send, { flush: true });
    expect(sent).toHaveLength(2);
    spy.mockRestore();
  });
});

