import { describe, expect, it, vi } from "vitest";
import { RedditError, createRedditClient, parseThread } from "../src/reddit/client";

const listing = (kind: string, items: object[]) => ({ data: { children: items.map((data) => ({ kind, data })) } });
const threadJson = (comments: object[], post: object = {}) => [
  listing("t3", [{ id: "p1", author: "op_user", selftext: "body", link_flair_text: "Help", num_comments: comments.length, locked: false, ...post }]),
  listing("t1", comments),
];
const comment = (id: string, score: number, o: object = {}) => ({ id, author: `u_${id}`, body: `comment ${id}`, score, ...o });

describe("parseThread", () => {
  it("sorts by score, caps at 8, marks OP, counts replies, drops stickied/deleted/AutoModerator", () => {
    const t = parseThread(
      threadJson([
        comment("mod", 99, { stickied: true }),
        comment("auto", 50, { author: "AutoModerator" }),
        comment("gone", 40, { author: "[deleted]" }),
        comment("op", 3, { author: "op_user", replies: listing("t1", [{}, {}]) }),
        ...Array.from({ length: 10 }, (_, i) => comment(`c${i}`, i)),
      ]),
      7,
    );
    expect(t.comments).toHaveLength(8);
    expect(t.comments[0]!.id).toBe("c9");
    expect(t.comments.map((c) => c.id)).not.toContain("mod");
    expect(t.comments.map((c) => c.id)).not.toContain("auto");
    const op = t.comments.find((c) => c.id === "op")!;
    expect(op).toMatchObject({ isOp: true, replyCount: 2 });
    expect(t).toMatchObject({ postId: "p1", flair: "Help", fetchedAt: 7 });
  });

  it("truncates long comments", () => {
    const t = parseThread(threadJson([comment("a", 1, { body: "x".repeat(900) })]), 0);
    expect(t.comments[0]!.body.length).toBe(401);
  });

  it("rejects JSON without a post", () => {
    expect(() => parseThread([{}, {}], 0)).toThrow(RedditError);
  });
});

function harness(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const clock = { now: 1_000_000 };
  const sleeps: number[] = [];
  const store = new Map<string, unknown>();
  const fetch = vi.fn(async (_url: string) => {
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  });
  const client = createRedditClient({
    fetch,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    origin: "https://www.reddit.com",
    store: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
  });
  return { client, fetch, sleeps, clock, store };
}

describe("reddit client", () => {
  it("fetches thread JSON with cookies and caches it for 30 minutes", async () => {
    const h = harness([{ body: threadJson([comment("a", 1)]) }, { body: threadJson([comment("b", 1)]) }]);
    await h.client.thread("/r/n8n/comments/p1/x");
    await h.client.thread("https://www.reddit.com/r/n8n/comments/p1/x/");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0]![0]).toBe("https://www.reddit.com/r/n8n/comments/p1/x/.json?raw_json=1&limit=40&sort=top");
    expect((h.fetch.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe("include");
    h.clock.now += 31 * 60_000;
    const t = await h.client.thread("/r/n8n/comments/p1/x/");
    expect(t.comments[0]!.id).toBe("b");
  });

  it("keeps at least 2 seconds between requests", async () => {
    const h = harness([{ body: threadJson([]) }, { body: threadJson([], { id: "p2" }) }]);
    await Promise.all([h.client.thread("/r/a/comments/p1/x/"), h.client.thread("/r/a/comments/p2/y/")]);
    expect(h.sleeps).toEqual([2000]);
  });

  it("pauses until reset when the budget runs low, and after a 429", async () => {
    const h = harness([
      { body: threadJson([]), headers: { "x-ratelimit-remaining": "5.0", "x-ratelimit-reset": "120" } },
      { body: threadJson([], { id: "p2" }) },
    ]);
    await h.client.thread("/r/a/comments/p1/x/");
    expect(h.client.pausedUntil - h.clock.now).toBe(120_000);
    await h.client.thread("/r/a/comments/p2/y/");
    expect(h.sleeps[0]).toBe(120_000);

    const g = harness([{ status: 429, body: {}, headers: { "x-ratelimit-reset": "30" } }]);
    await expect(g.client.thread("/r/a/comments/p1/x/")).rejects.toMatchObject({ status: 429 });
    expect(g.client.pausedUntil - g.clock.now).toBe(30_000);
  });

  it("surfaces 403 for logged-out users", async () => {
    const h = harness([{ status: 403, body: {} }]);
    await expect(h.client.thread("/r/a/comments/p1/x/")).rejects.toMatchObject({ status: 403 });
  });

  it("caches identity for a day in storage and lists replied thread ids", async () => {
    const h = harness([
      { body: { data: { name: "viewer_x" } } },
      { body: listing("t1", [{ link_id: "t3_aaa" }, { link_id: "t3_bbb" }]) },
    ]);
    expect(await h.client.username()).toBe("viewer_x");
    expect([...(await h.client.repliedThreads())]).toEqual(["aaa", "bbb"]);
    expect(h.fetch.mock.calls[1]![0]).toContain("/user/viewer_x/comments/.json");
    expect(h.store.get("me")).toMatchObject({ name: "viewer_x" });
    await h.client.markReplied("ccc");
    expect((h.store.get("replied") as { ids: string[] }).ids).toContain("ccc");
  });

  it("uses stored identity and replied set instead of refetching", async () => {
    const h = harness([]);
    h.store.set("me", { name: "viewer_x", at: h.clock.now - 1000 });
    h.store.set("replied", { ids: ["zzz"], at: h.clock.now - 1000 });
    expect(await h.client.username()).toBe("viewer_x");
    expect([...(await h.client.repliedThreads())]).toEqual(["zzz"]);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("treats a failed identity lookup as logged out", async () => {
    const h = harness([{ status: 403, body: {} }]);
    expect(await h.client.username()).toBeNull();
    expect((await h.client.repliedThreads()).size).toBe(0);
  });
});
