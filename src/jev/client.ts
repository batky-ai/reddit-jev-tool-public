// TypeSafe Jev client. Request shape confirmed with a live call on 2026-09-21
// (test/fixtures/jev-tier1-response.json). Runs in the service worker only.

import type { AssessRequestMessage, Card, FeedPost, Tier, Tier1Verdict, Tier2Verdict } from "../shared/types";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

const MATCH_LEVELS = [
  "No overlap with the cards",
  "Tangential overlap",
  "Partial overlap, could give general pointers",
  "Strong overlap, could answer most of it",
  "Exact match, could answer fully and specifically",
];
const BODY_CAP = 2_000;

interface NoulAnswer { type: "noul"; noul: number }
interface ScoreAnswer { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
interface ChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevResponse {
  model: string;
  answers: Record<string, NoulAnswer | ScoreAnswer | ChoiceAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export function buildTier1Request(post: FeedPost, cards: Card[], model: string) {
  const criteria: Record<string, string> = {};
  for (const c of cards) criteria[c.id] = c.title;
  criteria.none = "None of the cards apply";
  return {
    model,
    state: {
      post: {
        subreddit: post.subreddit,
        title: post.title,
        body: post.body.slice(0, BODY_CAP),
        flair: post.flair || undefined,
        comment_count: post.commentCount,
      },
      expertise_cards: cards.map((c) => ({ id: c.id, title: c.title, summary: c.summary })),
    },
    questions: {
      is_help_request: {
        type: "noul",
        instructions: "Is the author asking for help or advice that someone could answer?",
      },
      expertise_match: {
        type: "score",
        instructions:
          "How well could a person with exactly these expertise cards give a useful, specific answer to this post?",
        criteria: MATCH_LEVELS,
      },
      best_card: {
        type: "choice",
        instructions: "Which expertise card is most relevant to answering this post?",
        criteria,
      },
    },
  };
}

export class JevError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
  }
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || Number.isNaN(v)) throw new JevError(`Jev response missing ${field}`, false);
  return v;
}

export function parseTier1(postId: string, res: JevResponse, now = Date.now()): Tier1Verdict {
  const help = res.answers.is_help_request as NoulAnswer | undefined;
  const match = res.answers.expertise_match as ScoreAnswer | undefined;
  const best = res.answers.best_card as ChoiceAnswer | undefined;
  const bestCard = best && best.choice !== "none" ? best.choice : null;
  return {
    postId,
    helpProb: num(help?.noul, "is_help_request"),
    match: num(match?.score, "expertise_match") / (MATCH_LEVELS.length - 1),
    matchConfidence: num(match?.confidence, "expertise_match.confidence"),
    bestCard,
    bestCardProb: bestCard ? (best?.probabilities[bestCard] ?? 0) : 0,
    model: res.model,
    inputTokens: res.usage?.input_tokens ?? 0,
    scoredAt: now,
  };
}

/** Tier 2: judged on the preview only, over the post plus its top comments. Usernames never leave the extension. */
export function buildTier2Request(
  post: FeedPost,
  comments: AssessRequestMessage["comments"],
  cards: Card[],
  model: string,
) {
  // One yes/no per comment with a sharp "gap" definition. Live tests (2026-09-21, 16
  // synthetic comments): real gaps (open question, wrong advice, missing step) scored
  // 0.83-0.93, the best-scoring non-gap 0.74. A loose "could add value" noul scored
  // noise up to 0.87, and a single best-reply choice found only one gap per batch and
  // still picked something in a batch of pure noise.
  const gaps: Record<string, { type: "noul"; instructions: string }> = {};
  comments.forEach((_, i) => {
    gaps[`gap_${i}`] = {
      type: "noul",
      instructions: `Comment ${i}: is there a specific technical question in it that is still unanswered, or technical advice in it that is wrong or missing an important step, which a person with these expertise cards could correct or answer? Answer no for opinions, praise, jokes, me-too, questions aimed at the original poster, and advice that is already correct and complete.`,
    };
  });
  return {
    model,
    state: {
      post: { subreddit: post.subreddit, title: post.title, body: post.body.slice(0, BODY_CAP) },
      comments: comments.map((c, i) => ({
        number: i,
        from_original_poster: c.isOp,
        score: c.score,
        replies: c.replyCount,
        text: c.body,
      })),
      expertise_cards: cards.map((c) => ({ id: c.id, title: c.title, summary: c.summary })),
    },
    questions: {
      ...gaps,
      already_well_answered: {
        type: "noul",
        instructions:
          "Do the existing comments already give the original poster a correct, specific and complete answer, so a new reply would add little?",
      },
      op_still_needs_help: {
        type: "noul",
        instructions:
          "Based on the original poster's own comments, if any, do they still need help (not solved, still asking follow-up questions or confused)?",
      },
    },
  };
}

export function parseTier2(postId: string, res: JevResponse, commentIds: string[] = [], now = Date.now()): Tier2Verdict {
  const answered = res.answers.already_well_answered as NoulAnswer | undefined;
  const needs = res.answers.op_still_needs_help as NoulAnswer | undefined;
  const valueProbs: Record<string, number> = {};
  commentIds.forEach((id, i) => {
    const p = (res.answers[`gap_${i}`] as NoulAnswer | undefined)?.noul;
    if (typeof p === "number") valueProbs[id] = p;
  });
  return {
    postId,
    answeredProb: num(answered?.noul, "already_well_answered"),
    stillNeedsProb: num(needs?.noul, "op_still_needs_help"),
    valueProbs,
    inputTokens: res.usage?.input_tokens ?? 0,
    scoredAt: now,
  };
}

/**
 * Posts in your area that nobody has answered yet are where a reply helps most,
 * so they get a bonus: the full boost at 0 comments, half at 1 or 2. Only posts
 * already within 0.25 of the threshold qualify, so an off-topic post never
 * climbs just because it is empty. Learning always uses the raw match.
 */
export function boostedMatch(match: number, commentCount: number, threshold: number, boost: number): number {
  if (boost <= 0 || match < threshold - 0.25) return match;
  const bonus = commentCount === 0 ? boost : commentCount <= 2 ? boost / 2 : 0;
  return Math.min(1, match + bonus);
}

export function tierFor(v: Pick<Tier1Verdict, "helpProb" | "match">, threshold: number): Tier {
  if (v.helpProb < 0.5) return "none";
  if (v.match >= Math.max(threshold + 0.2, 0.85)) return "strong";
  if (v.match >= threshold) return "good";
  if (v.match >= threshold - 0.15) return "maybe";
  return "none";
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function callJev(
  apiKey: string,
  body: unknown,
  opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; attempts?: number; timeoutMs?: number } = {},
): Promise<JevResponse> {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 3;
  if (!apiKey) throw new JevError("No TypeSafe API key. Add one in the extension options.", false);

  let last: JevError = new JevError("Jev call did not run", true);
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1000 * 2 ** (i - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    try {
      const res = await doFetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return (await res.json()) as JevResponse;
      const detail = (await res.text()).slice(0, 200);
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      last = new JevError(`Jev HTTP ${res.status}: ${detail}`, retryable, res.status);
      if (!retryable) throw last;
    } catch (e) {
      if (e instanceof JevError && !e.retryable) throw e;
      last = e instanceof JevError ? e : new JevError(`Jev request failed: ${(e as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}
