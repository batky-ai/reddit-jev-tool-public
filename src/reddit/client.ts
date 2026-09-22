// Reddit reads from the user's own logged-in session (same origin, cookies
// sent automatically). Runs in the content script only. Politeness rules:
// user-initiated only, at most one request per 2 seconds, 30 minute cache,
// and a full pause when the JSON rate-limit budget runs low.

export interface ThreadComment {
  id: string;
  author: string;
  body: string;
  score: number;
  isOp: boolean;
  replyCount: number;
  /** Site-relative link to the comment itself, from Reddit's JSON. */
  permalink: string;
}

export interface Thread {
  postId: string;
  flair: string;
  selftext: string;
  author: string;
  numComments: number;
  locked: boolean;
  comments: ThreadComment[];
  fetchedAt: number;
}

export class RedditError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientDeps {
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  origin: string;
  /** Persists identity and the replied set across page loads. */
  store?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
}

const GAP_MS = 2_000;
const CACHE_MS = 30 * 60_000;
const IDENTITY_MS = 24 * 3_600_000;
const LOW_BUDGET = 10;
const COMMENT_CAP = 8;
const COMMENT_CHARS = 400;

interface Listing<T> { data?: { children?: Array<{ kind: string; data: T }> } }
interface RawPost { id: string; author: string; selftext: string; link_flair_text: string | null; num_comments: number; locked: boolean }
interface RawComment { id: string; author: string; body: string; score: number; permalink?: string; stickied?: boolean; replies?: Listing<unknown> | "" }
interface RawUserComment { link_id: string }

export function parseThread(json: unknown, now: number): Thread {
  const [postListing, commentListing] = json as [Listing<RawPost>, Listing<RawComment>];
  const post = postListing?.data?.children?.[0]?.data;
  if (!post) throw new RedditError("Thread JSON had no post");
  const comments = (commentListing?.data?.children ?? [])
    .filter((c) => c.kind === "t1" && !c.data.stickied && c.data.author !== "[deleted]" && c.data.author !== "AutoModerator")
    .map(({ data: c }) => ({
      id: c.id,
      author: c.author,
      body: c.body.length > COMMENT_CHARS ? `${c.body.slice(0, COMMENT_CHARS)}…` : c.body,
      score: c.score,
      isOp: c.author === post.author,
      replyCount: typeof c.replies === "object" ? (c.replies.data?.children?.filter((r) => r.kind === "t1").length ?? 0) : 0,
      permalink: c.permalink ?? "",
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, COMMENT_CAP);
  return {
    postId: post.id,
    flair: post.link_flair_text ?? "",
    selftext: post.selftext,
    author: post.author,
    numComments: post.num_comments,
    locked: post.locked,
    comments,
    fetchedAt: now,
  };
}

export function createRedditClient(deps: ClientDeps) {
  let lastRequest = 0;
  let pausedUntil = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const threads = new Map<string, Thread>();
  let replied: { ids: Set<string>; at: number } | null = null;
  let me: string | null | undefined;

  function getJson(path: string): Promise<unknown> {
    // Serialize every request so the gap and the budget pause hold across callers.
    const run = queue.then(async () => {
      const wait = Math.max(lastRequest + GAP_MS, pausedUntil) - deps.now();
      if (wait > 0) await deps.sleep(wait);
      lastRequest = deps.now();
      const res = await deps.fetch(`${deps.origin}${path}`, { credentials: "include" });
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (res.status === 429 || (Number.isFinite(remaining) && remaining < LOW_BUDGET && res.headers.has("x-ratelimit-remaining"))) {
        pausedUntil = deps.now() + (Number.isFinite(reset) && reset > 0 ? reset : 60) * 1000;
      }
      if (!res.ok) throw new RedditError(`Reddit HTTP ${res.status} for ${path.split("?")[0]}`, res.status);
      return res.json();
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    /** Top comments of a thread; cached 30 minutes. */
    async thread(permalink: string): Promise<Thread> {
      const path = permalink.replace(/^https?:\/\/[^/]+/, "").replace(/\/?$/, "/");
      const hit = threads.get(path);
      if (hit && deps.now() - hit.fetchedAt < CACHE_MS) return hit;
      const t = parseThread(await getJson(`${path}.json?raw_json=1&limit=40&sort=top`), deps.now());
      threads.set(path, t);
      return t;
    },

    /** Signed-in username, or null when logged out. */
    async username(): Promise<string | null> {
      if (me !== undefined) return me;
      const saved = (await deps.store?.get("me")) as { name: string; at: number } | undefined;
      if (saved?.name && deps.now() - saved.at < IDENTITY_MS) return (me = saved.name);
      try {
        const d = (await getJson("/api/me.json")) as { data?: { name?: string }; name?: string };
        me = d?.data?.name ?? d?.name ?? null;
      } catch {
        me = null;
      }
      if (me) await deps.store?.set("me", { name: me, at: deps.now() });
      return me;
    },

    /** Post ids of threads the user has commented in; cached 30 minutes. */
    async repliedThreads(): Promise<Set<string>> {
      if (!replied) {
        const saved = (await deps.store?.get("replied")) as { ids: string[]; at: number } | undefined;
        if (saved) replied = { ids: new Set(saved.ids), at: saved.at };
      }
      if (replied && deps.now() - replied.at < CACHE_MS) return replied.ids;
      const name = await this.username();
      if (!name) return new Set();
      const d = (await getJson(`/user/${encodeURIComponent(name)}/comments/.json?raw_json=1&limit=100`)) as Listing<RawUserComment>;
      const ids = new Set((d?.data?.children ?? []).map((c) => c.data.link_id.replace(/^t3_/, "")));
      replied = { ids, at: deps.now() };
      await deps.store?.set("replied", { ids: [...ids], at: replied.at });
      return ids;
    },

    /** Adds a thread to the cached set until the next refetch. Durable "answered" state lives in the feedback store. */
    async markReplied(postId: string): Promise<void> {
      if (!replied) return;
      replied.ids.add(postId);
      await deps.store?.set("replied", { ids: [...replied.ids], at: replied.at });
    },

    get pausedUntil(): number {
      return pausedUntil;
    },
  };
}

export type RedditClient = ReturnType<typeof createRedditClient>;
