// @vitest-environment jsdom
// Drives the real content pipeline (observer -> extract -> replied check ->
// prefilter -> message -> highlight -> preview -> feedback) against the
// contract fixture with chrome, the observers and Reddit mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedditClient, Thread } from "../src/reddit/client";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { Card, ScoreRequestMessage, Tier1Verdict } from "../src/shared/types";
import { fixture } from "./fixture";

const cards: Card[] = [{ id: "n8n-cloud", title: "n8n cloud workflows", summary: "s", keywords: ["n8n", "webhook"] }];
const settings = { ...DEFAULT_SETTINGS, apiKey: "k" };

let observed: Element[] = [];
class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    observed.push(el);
    queueMicrotask(() => this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
}

const verdict = (postId: string, match: number, o: Partial<Tier1Verdict> = {}): Tier1Verdict => ({
  postId, helpProb: 0.95, match, matchConfidence: 0.9, bestCard: "n8n-cloud", bestCardProb: 0.8, model: "jev-1.13.0", inputTokens: 1, scoredAt: 0, ...o,
});

function installChrome(store: Record<string, unknown>, reply: (m: { type: string } & Record<string, unknown>) => unknown) {
  const sendMessage = vi.fn(async (m: { type: string } & Record<string, unknown>) => reply(m));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => void Object.assign(store, o),
        remove: async () => {},
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { sendMessage },
  };
  return sendMessage;
}

function fakeClient(o: { me?: string | null; replied?: string[]; thread?: Partial<Thread> } = {}): RedditClient {
  return {
    username: vi.fn(async () => o.me ?? null),
    repliedThreads: vi.fn(async () => new Set(o.replied ?? [])),
    markReplied: vi.fn(async () => {}),
    thread: vi.fn(async () => ({
      postId: "abc123", flair: "", selftext: "", author: "someone_else", numComments: 1, locked: false, fetchedAt: 0,
      comments: [{ id: "c1", author: "someone_else", body: "still broken <img src=x onerror=alert(1)>", score: 2, isOp: true, replyCount: 0, permalink: "/r/n8n/comments/abc123/x/c1/" }],
      ...o.thread,
    })),
    pausedUntil: 0,
  } as unknown as RedditClient;
}

const settle = () => new Promise((r) => setTimeout(r, 30));
let stop: (() => void) | undefined;

async function start(client: RedditClient) {
  const { startFeed } = await import("../src/content/feed");
  stop = await startFeed(client);
  await settle();
}

describe("feed pipeline", () => {
  afterEach(() => {
    stop?.();
    stop = undefined;
    document.getElementById("rjt-panel")?.remove();
  });

  beforeEach(() => {
    vi.resetModules();
    observed = [];
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
    window.history.replaceState({}, "", "/r/n8n/new/");
    document.body.innerHTML = fixture("contract-feed.html");
  });

  it("scores only the help request that overlaps a card and highlights its card", async () => {
    const send = installChrome({ settings, cards }, (m) => ({ ok: true, cached: false, verdict: verdict((m as unknown as ScoreRequestMessage).post.id, 0.95) }));
    await start(fakeClient());

    expect(observed).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(1);
    const article = document.querySelector("article")!;
    expect(article.getAttribute("data-rjt-tier")).toBe("strong");
    const badge = article.querySelector(".rjt-badge")!;
    expect(badge.nextElementSibling?.tagName).toBe("SHREDDIT-POST");
    expect(badge.textContent).toBe("Strong match 95% · n8n cloud workflows ▸");
  });

  it("dims threads you already replied in and your own posts, without calling Jev", async () => {
    const send = installChrome({ settings, cards }, () => ({ ok: false, error: "x", retryable: false }));
    await start(fakeClient({ me: "someone_else" }));
    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector("article")!.getAttribute("data-rjt-tier")).toBe("replied");
    expect(document.querySelector(".rjt-badge")!.textContent).toBe("Your post");

    stop?.();
    vi.resetModules();
    document.body.innerHTML = fixture("contract-feed.html");
    const send2 = installChrome({ settings, cards }, () => ({ ok: false, error: "x", retryable: false }));
    await start(fakeClient({ me: "viewer", replied: ["abc123"] }));
    expect(send2).not.toHaveBeenCalled();
    expect(document.querySelector(".rjt-badge")!.textContent).toBe("You replied");
  });

  it("boosts an in-area post nobody has answered yet and says so on the badge", async () => {
    installChrome({ settings, cards }, (m) => ({ ok: true, cached: false, verdict: verdict((m as unknown as ScoreRequestMessage).post.id, 0.55) }));
    await start(fakeClient());
    // Fixture post has 3 comments: 0.55 stays a maybe.
    expect(document.querySelector("article")!.getAttribute("data-rjt-tier")).toBe("maybe");
    const empty = document.createElement("article");
    empty.innerHTML =
      '<shreddit-post id="t3_zero1" permalink="/r/n8n/comments/zero1/x/" post-title="How do I fix my n8n webhook?" subreddit-prefixed-name="r/n8n" comment-count="0"></shreddit-post>';
    document.body.appendChild(empty);
    await settle();
    expect(empty.getAttribute("data-rjt-tier")).toBe("good");
    expect(empty.querySelector(".rjt-badge")!.textContent).toBe("Good match 65% · n8n cloud workflows · no replies yet ▸");
  });

  it("uses the learned threshold for the subreddit", async () => {
    installChrome(
      { settings, cards, learned: { thresholdDelta: 0, subredditOffsets: { n8n: -0.1 }, keywordWeights: {}, labelled: 8, updatedAt: 1 } },
      (m) => ({ ok: true, cached: false, verdict: verdict((m as unknown as ScoreRequestMessage).post.id, 0.52) }),
    );
    await start(fakeClient());
    // 0.52 is "maybe" at the base 0.6, but "good" at the learned 0.5 for r/n8n.
    expect(document.querySelector("article")!.getAttribute("data-rjt-tier")).toBe("good");
  });

  it("opens a preview with comments as text, tier 2 chips, and records feedback that dims the card", async () => {
    const store: Record<string, unknown> = { settings, cards };
    const send = installChrome(store, (m) =>
      m.type === "assess"
        ? { ok: true, cached: false, verdict: { postId: "abc123", answeredProb: 0.1, stillNeedsProb: 0.9, valueProbs: { c1: 0.9 }, inputTokens: 1, scoredAt: 0 } }
        : { ok: true, cached: false, verdict: verdict("abc123", 0.95) },
    );
    await start(fakeClient());
    (document.querySelector(".rjt-badge") as HTMLButtonElement).click();
    await settle();

    const panel = document.getElementById("rjt-panel")!;
    expect(panel.querySelector(".rjt-title")!.textContent).toContain("How do I trigger an n8n workflow");
    expect(panel.querySelector(".rjt-comment img")).toBeNull(); // comment HTML is shown as text
    expect(panel.querySelector(".rjt-comment p")!.textContent).toContain("<img src=x");
    const chips = [...panel.querySelectorAll(".rjt-chip")].map((c) => c.textContent);
    expect(chips).toEqual(
      expect.arrayContaining(["Already answered 10%", "OP still needs help 90%", "OP", "Good place to reply 90%", "1 place to add value"]),
    );
    expect(panel.querySelector<HTMLAnchorElement>(".rjt-value .rjt-reply")!.href).toBe("http://localhost:3000/r/n8n/comments/abc123/x/c1/");
    const assess = send.mock.calls.find(([m]) => m.type === "assess")![0] as unknown as { comments: object[]; cards: Card[] };
    expect(JSON.stringify(assess.comments)).not.toContain("someone_else");
    expect(assess.cards.map((c) => c.id)).toEqual(["n8n-cloud"]);

    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Skip")!.click();
    await settle();
    expect(document.getElementById("rjt-panel")).toBeNull();
    expect(document.querySelector("article")!.getAttribute("data-rjt-tier")).toBe("dismissed");
    const log = store.feedback as Array<{ action: string; hits: string[] }>;
    expect(log.map((e) => e.action)).toEqual(["previewed", "skipped"]);
    expect(log[1]!.hits).toEqual(expect.arrayContaining(["n8n-cloud::n8n", "n8n-cloud::webhook"]));
    expect(store.learned).toBeDefined();
  });

  it("offers to add a card when you answer a post no card matched", async () => {
    const store: Record<string, unknown> = { settings, cards };
    installChrome(store, (m) =>
      m.type === "assess" ? { ok: false, error: "x", retryable: false } : { ok: true, cached: false, verdict: verdict("abc123", 0.5, { bestCard: null }) },
    );
    await start(fakeClient());
    (document.querySelector(".rjt-badge") as HTMLButtonElement).click();
    await settle();
    const panel = document.getElementById("rjt-panel")!;
    [...panel.querySelectorAll("button")].find((b) => b.textContent === "I answered")!.click();
    await settle();
    const form = panel.querySelector("form.rjt-addcard") as HTMLFormElement;
    expect(form).not.toBeNull();
    const [title, keywords] = form.querySelectorAll("input");
    title!.value = "WhatsApp Business API";
    keywords!.value = "whatsapp, coexistence";
    form.querySelector("textarea")!.value = "Connects WhatsApp numbers to automations.";
    form.requestSubmit();
    await settle();
    expect((store.cards as Card[]).map((c) => c.id)).toEqual(["n8n-cloud-workflows", "whatsapp-business-api"]);
    expect(document.querySelector("article")!.getAttribute("data-rjt-tier")).toBe("replied");
  });

  it("shows a login hint when Reddit refuses the thread", async () => {
    installChrome({ settings, cards }, () => ({ ok: true, cached: false, verdict: verdict("abc123", 0.95) }));
    const client = fakeClient();
    const { RedditError } = await import("../src/reddit/client");
    (client.thread as ReturnType<typeof vi.fn>).mockRejectedValue(new RedditError("no", 403));
    await start(client);
    (document.querySelector(".rjt-badge") as HTMLButtonElement).click();
    await settle();
    expect(document.getElementById("rjt-panel")!.textContent).toContain("Log in to Reddit to see comments");
  });

  it("does nothing on thread pages", async () => {
    window.history.replaceState({}, "", "/r/n8n/comments/abc123/x/");
    const send = installChrome({ settings, cards }, () => ({ ok: false, error: "x", retryable: false }));
    await start(fakeClient());
    expect(send).not.toHaveBeenCalled();
  });

  it("shows one notice and no highlight when the key is missing", async () => {
    installChrome({ settings: { ...settings, apiKey: "" }, cards }, () => ({ ok: false, error: "No TypeSafe API key set", retryable: false }));
    await start(fakeClient());
    expect(document.querySelectorAll(".rjt-notice")).toHaveLength(1);
    expect(document.querySelector("article")!.hasAttribute("data-rjt-state")).toBe(false);
  });

  it("re-checks unmarked posts after in-app navigation back to a feed", async () => {
    const send = installChrome({ settings, cards }, (m) => ({ ok: true, cached: false, verdict: verdict((m as unknown as ScoreRequestMessage).post.id, 0.95) }));
    await start(fakeClient());
    expect(send).toHaveBeenCalledTimes(1);
    // Reddit re-renders the card: our marks are gone but the element is the same.
    const article = document.querySelector("article")!;
    article.removeAttribute("data-rjt-tier");
    article.querySelector(".rjt-badge")!.remove();
    const { rescanFeed } = await import("../src/content/feed");
    rescanFeed();
    await settle();
    expect(article.getAttribute("data-rjt-tier")).toBe("strong");
    expect(article.querySelector(".rjt-badge")).not.toBeNull();
  });

  it("tells you to reply to the post when no comment has an open gap", async () => {
    installChrome({ settings, cards }, (m) =>
      m.type === "assess"
        ? { ok: true, cached: false, verdict: { postId: "abc123", answeredProb: 0.2, stillNeedsProb: 0.8, valueProbs: { c1: 0.3 }, inputTokens: 1, scoredAt: 0 } }
        : { ok: true, cached: false, verdict: verdict("abc123", 0.95) },
    );
    await start(fakeClient({ thread: { comments: [{ id: "c1", author: "x", body: "Did you check the logs.", score: 1, isOp: false, replyCount: 0, permalink: "/c1/" }] } }));
    (document.querySelector(".rjt-badge") as HTMLButtonElement).click();
    await settle();
    const where = document.querySelector<HTMLElement>("#rjt-panel .rjt-where")!;
    expect(where.dataset.kind).toBe("post");
    expect(where.textContent).toContain("Reply to the post itself: no comment leaves a gap you'd fill (highest 30%).");
    expect(where.querySelector<HTMLAnchorElement>("a")!.href).toBe("http://localhost:3000/r/n8n/comments/abc123/how_do_i_trigger/");
    expect(document.querySelector("#rjt-panel .rjt-value")).toBeNull();
  });

  it("after the extension is reloaded under an open tab, says to reload the tab instead of hanging", async () => {
    const store: Record<string, unknown> = { settings, cards };
    installChrome(store, (m) => {
      if (m.type === "assess") throw new Error("Extension context invalidated.");
      return { ok: true, cached: false, verdict: verdict("abc123", 0.95) };
    });
    await start(fakeClient());
    (document.querySelector(".rjt-badge") as HTMLButtonElement).click();
    await settle();
    const chips = [...document.querySelectorAll("#rjt-panel .rjt-chip")].map((c) => c.textContent);
    expect(chips).toContain("Jev: The extension was updated. Reload this tab.");
    expect(chips).not.toContain("Checking answers…");
  });

  it("shows the reload notice on the feed when scoring fails the same way", async () => {
    installChrome({ settings, cards }, () => {
      throw new Error("Extension context invalidated.");
    });
    await start(fakeClient());
    expect(document.querySelector(".rjt-notice")!.textContent).toBe("Reddit Jev Tool: The extension was updated. Reload this tab.");
  });

  it("counts every outcome in the feed status pill", async () => {
    installChrome({ settings, cards }, (m) => ({ ok: true, cached: false, verdict: verdict((m as unknown as ScoreRequestMessage).post.id, 0.95) }));
    await start(fakeClient());
    const pill = document.getElementById("rjt-feed-status")!;
    // Fixture: one scored help request, one showcase post, one card without a permalink.
    expect(pill.textContent).toBe("Jev · 1 highlighted of 2 checked");
    pill.click();
    expect(pill.textContent).toContain("Skipped, not a help request: 1");
    expect(pill.textContent).toContain("Skipped, unreadable card: 1");
  });

  it("retries a post whose scoring failed temporarily, and shows the error meanwhile", async () => {
    let calls = 0;
    installChrome({ settings, cards }, (m) => {
      calls++;
      return calls === 1
        ? { ok: false, error: "Jev request failed: timeout", retryable: true }
        : { ok: true, cached: false, verdict: verdict((m as unknown as ScoreRequestMessage).post.id, 0.95) };
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { startFeed } = await import("../src/content/feed");
      stop = await startFeed(fakeClient());
      await vi.advanceTimersByTimeAsync(50);
      const pill = document.getElementById("rjt-feed-status")!;
      expect(pill.textContent).toContain("1 error");
      expect(document.querySelector("article")!.hasAttribute("data-rjt-tier")).toBe(false);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(calls).toBe(2);
      expect(document.querySelector("article")!.getAttribute("data-rjt-tier")).toBe("strong");
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns an exception while scoring into a counted error instead of silence", async () => {
    installChrome({ settings, cards }, () => ({ ok: true, cached: false, verdict: null }));
    await start(fakeClient());
    expect(document.getElementById("rjt-feed-status")!.textContent).toContain("1 error");
  });
});

