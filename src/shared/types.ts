import type { FeedPost } from "../reddit/adapter";

export type { FeedPost };

/** One piece of the user's expertise. The format is the product; content is per user. */
export interface Card {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
}

export type SubredditMode = "all" | "only";

export interface Settings {
  apiKey: string;
  model: string;
  subredditMode: SubredditMode;
  subreddits: string[];
  /** 0..1 on the normalized expertise_match score. Learning re-fits this. */
  threshold: number;
  maxComments: number;
  /** Score help requests even when no card keyword appears in the post. */
  scoreWithoutKeywords: boolean;
  dailyCallCap: number;
  /** Added to the match of in-area posts with 0 comments (half at 1-2). */
  unansweredBoost: number;
  /** On thread pages, mark comments where the user could add value. */
  scanThreads: boolean;
  enabled: boolean;
}

export interface Tier1Verdict {
  postId: string;
  helpProb: number;
  /** expertise_match normalized to 0..1 */
  match: number;
  matchConfidence: number;
  bestCard: string | null;
  bestCardProb: number;
  model: string;
  inputTokens: number;
  scoredAt: number;
}

export interface Tier2Verdict {
  postId: string;
  answeredProb: number;
  stillNeedsProb: number;
  /** Per comment id: Jev's probability that the comment has a gap this user could fill. */
  valueProbs: Record<string, number>;
  inputTokens: number;
  scoredAt: number;
}

export type Tier = "strong" | "good" | "maybe" | "none";

export type ScoreResponse =
  | { ok: true; verdict: Tier1Verdict; cached: boolean }
  | { ok: false; error: string; retryable: boolean };

export type AssessResponse =
  | { ok: true; verdict: Tier2Verdict; cached: boolean }
  | { ok: false; error: string; retryable: boolean };

export interface ScoreRequestMessage {
  type: "score";
  post: FeedPost;
  cards: Card[];
}

/** Comments are sent without authors; `isOp` is computed in the content script. */
export interface AssessRequestMessage {
  type: "assess";
  post: FeedPost;
  comments: Array<{ id: string; body: string; score: number; isOp: boolean; replyCount: number }>;
  /** The post's candidate cards, so Jev can judge where this user specifically could help. */
  cards: Card[];
}
