// Turns posts into Jev verdicts: cache, daily spend cap, bounded concurrency,
// then Jev. Tier 1 (score) runs on feed cards; tier 2 (assess) only when the
// user opens a preview. Dependencies are injected so it runs in tests.

import {
  buildTier1Request,
  buildTier2Request,
  callJev,
  JevError,
  parseTier1,
  parseTier2,
  type JevResponse,
} from "../jev/client";
import type {
  AssessRequestMessage,
  AssessResponse,
  Card,
  FeedPost,
  ScoreResponse,
  Settings,
  Tier1Verdict,
  Tier2Verdict,
} from "../shared/types";

export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ScorerDeps {
  cache: KV; // survives service-worker restarts within a browser session
  counters: KV; // survives browser restarts
  loadSettings(): Promise<Settings>;
  jev(apiKey: string, body: unknown): Promise<JevResponse>;
  now(): number;
}

const CACHE_TTL_MS = 6 * 3_600_000;
const MAX_CONCURRENT = 4;

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Cache key includes the candidate cards, so editing cards re-scores posts. */
export function cacheKey(postId: string, cards: Card[], model: string): string {
  return `v:${model}:${postId}:${hash(cards.map((c) => `${c.id}:${c.title}:${c.summary.length}`).join("|"))}`;
}

/** Tier 2 is re-judged when the top comments or the candidate cards change. */
export function assessKey(postId: string, comments: AssessRequestMessage["comments"], cards: Card[], model: string): string {
  const sig = comments.map((c) => `${c.id}:${c.score}`).join("|") + "#" + cards.map((c) => `${c.id}:${c.title}:${c.summary.length}`).join("|");
  return `a2:${model}:${postId}:${hash(sig)}`;
}

type Outcome<V> = { ok: true; verdict: V; cached: boolean } | { ok: false; error: string; retryable: boolean };

export function createScorer(deps: ScorerDeps) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const inflight = new Map<string, Promise<Outcome<unknown>>>();

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  async function takeBudget(cap: number): Promise<boolean> {
    const day = utcDay(deps.now());
    const rec = ((await deps.counters.get("jevCalls")) as { day: string; count: number } | undefined) ?? { day, count: 0 };
    const count = rec.day === day ? rec.count : 0;
    if (count >= cap) return false;
    await deps.counters.set("jevCalls", { day, count: count + 1 });
    return true;
  }

  async function run<V extends { scoredAt: number }>(
    key: string,
    body: (s: Settings) => unknown,
    parse: (res: JevResponse) => V,
  ): Promise<Outcome<V>> {
    const settings = await deps.loadSettings();
    const cached = (await deps.cache.get(key)) as V | undefined;
    if (cached && deps.now() - cached.scoredAt < CACHE_TTL_MS) return { ok: true, verdict: cached, cached: true };
    if (!settings.apiKey) return { ok: false, error: "No TypeSafe API key set", retryable: false };
    if (!(await takeBudget(settings.dailyCallCap)))
      return { ok: false, error: `Daily Jev call cap of ${settings.dailyCallCap} reached`, retryable: false };
    try {
      const verdict = parse(await slot(() => deps.jev(settings.apiKey, body(settings))));
      await deps.cache.set(key, verdict);
      return { ok: true, verdict, cached: false };
    } catch (e) {
      return { ok: false, error: (e as Error).message, retryable: e instanceof JevError ? e.retryable : true };
    }
  }

  function once<V>(key: string, fn: () => Promise<Outcome<V>>): Promise<Outcome<V>> {
    const existing = inflight.get(key) as Promise<Outcome<V>> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    async score(post: FeedPost, cards: Card[]): Promise<ScoreResponse> {
      const { model } = await deps.loadSettings();
      const key = cacheKey(post.id, cards, model);
      return once<Tier1Verdict>(key, () =>
        run(key, (s) => buildTier1Request(post, cards, s.model), (res) => parseTier1(post.id, res, deps.now())),
      );
    },

    async assess(post: FeedPost, comments: AssessRequestMessage["comments"], cards: Card[]): Promise<AssessResponse> {
      const { model } = await deps.loadSettings();
      const key = assessKey(post.id, comments, cards, model);
      const ids = comments.map((c) => c.id);
      return once<Tier2Verdict>(key, () =>
        run(key, (s) => buildTier2Request(post, comments, cards, s.model), (res) => parseTier2(post.id, res, ids, deps.now())),
      );
    },
  };
}

export const defaultJev = (apiKey: string, body: unknown) => callJev(apiKey, body);
