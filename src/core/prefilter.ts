// Free, local first pass. Only posts that survive cost a Jev call, so this is
// where spend is controlled. Pure functions: no DOM, no chrome APIs.

import { normalizeSub } from "../shared/settings";
import type { Card, FeedPost, Settings } from "../shared/types";

const QUESTION_START =
  /^(how|what|why|when|where|which|who|can|could|does|do|is|are|should|would|will|any|anyone|has anyone|help|need|looking for|recommend|best way|is there)\b/i;
const HELP_WORDS =
  /\b(help|stuck|struggling|error|issue|problem|not working|doesn'?t work|can'?t|cannot|fails?|failing|advice|recommend(ation)?s?|how (do|can|to)|best way|any ideas|suggestions?|question)\b/i;
const HELP_FLAIR = /\b(help|question|support|q&a|advice|troubleshoot)/i;

export interface HelpSignal {
  isLikelyHelp: boolean;
  reasons: string[];
}

export function helpSignal(post: Pick<FeedPost, "title" | "body" | "flair">): HelpSignal {
  const reasons: string[] = [];
  const title = post.title.trim();
  if (title.includes("?")) reasons.push("question mark");
  if (QUESTION_START.test(title)) reasons.push("question opener");
  if (HELP_FLAIR.test(post.flair)) reasons.push("help flair");
  if (HELP_WORDS.test(`${title} ${post.body.slice(0, 600)}`)) reasons.push("help wording");
  return { isLikelyHelp: reasons.length > 0, reasons };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the keyword appears as a whole word or phrase, case-insensitive. */
export function containsKeyword(text: string, keyword: string): boolean {
  const k = keyword.trim();
  if (!k) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(k)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export interface CardMatch {
  card: Card;
  score: number;
  /** Keywords found in the title or body. Only these feed learning. */
  hits: string[];
}

/**
 * Rank cards by weighted keyword hits in the post. weights key: `${cardId}::${keyword}`.
 * The subreddit name counts as text: in r/n8n, "help with my workflow" is about n8n
 * even when the post never says so (seen on the live r/n8n feed, 2026-09-22).
 */
export function rankCards(
  post: Pick<FeedPost, "title" | "body"> & { subreddit?: string },
  cards: Card[],
  weights: Record<string, number> = {},
): CardMatch[] {
  const text = `${post.title}\n${post.body}`;
  return cards
    .map((card) => {
      const hits = card.keywords.filter((k) => containsKeyword(text, k));
      // A subreddit-only match lets the post through at a fixed weight but is never
      // reported as a hit: learning from it would let a few Skips in r/n8n zero the
      // "n8n" keyword and silently filter out the whole subreddit.
      const viaSub = post.subreddit ? card.keywords.filter((k) => !hits.includes(k) && containsKeyword(post.subreddit!, k)) : [];
      const score = hits.reduce((sum, k) => sum + (weights[`${card.id}::${k.toLowerCase()}`] ?? 1), 0) + viaSub.length;
      return { card, score, hits };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Reddit archives posts after six months by default; archived posts take no replies. */
export const ARCHIVE_AFTER_MS = 180 * 24 * 3_600_000;

export type Rejection =
  | "disabled"
  | "subreddit"
  | "archived"
  | "too many comments"
  | "not a help request"
  | "no card overlap"
  | "no cards";

export interface PrefilterResult {
  pass: boolean;
  rejection?: Rejection;
  candidates: Card[];
  /** `${cardId}::${keyword}` for every keyword that matched a candidate card; learning re-weights these. */
  hits: string[];
  help: HelpSignal;
}

export function prefilter(
  post: FeedPost,
  cards: Card[],
  settings: Settings,
  opts: { now?: number; weights?: Record<string, number>; topK?: number } = {},
): PrefilterResult {
  const now = opts.now ?? Date.now();
  const help = helpSignal(post);
  const reject = (rejection: Rejection): PrefilterResult => ({ pass: false, rejection, candidates: [], hits: [], help });

  if (!settings.enabled) return reject("disabled");
  if (cards.length === 0) return reject("no cards");
  if (settings.subredditMode === "only") {
    const allowed = new Set(settings.subreddits.map(normalizeSub));
    if (!allowed.has(normalizeSub(post.subreddit))) return reject("subreddit");
  }
  // No age limit: older posts are often forgotten but still unanswered, so Jev judges
  // them too (Evan, 2026-09-22). Only posts past Reddit's default six-month archive
  // are skipped, because they can no longer be replied to.
  if (post.createdAt !== null && now - post.createdAt > ARCHIVE_AFTER_MS) return reject("archived");
  if (post.commentCount > settings.maxComments) return reject("too many comments");
  if (!help.isLikelyHelp) return reject("not a help request");

  const ranked = rankCards(post, cards, opts.weights);
  const topK = opts.topK ?? 5;
  if (ranked.length === 0) {
    if (!settings.scoreWithoutKeywords) return reject("no card overlap");
    return { pass: true, candidates: cards.slice(0, topK), hits: [], help };
  }
  const top = ranked.slice(0, topK);
  return {
    pass: true,
    candidates: top.map((m) => m.card),
    hits: top.flatMap((m) => m.hits.map((k) => `${m.card.id}::${k.toLowerCase()}`)),
    help,
  };
}
