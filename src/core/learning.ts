// v1 learning: only mechanisms that cannot make highlights noisier on their
// own. The user's labels re-fit the threshold, nudge it per subreddit, and
// re-weight card keywords in the prefilter. Few-shot examples inside the Jev
// state are deliberately NOT used: state is the content being judged, and
// distractor context flipped borderline decisions in the 2026-09-21 Jev eval.
// Pure functions: storage lives in the callers.

export type FeedbackAction = "answered" | "skipped" | "not-my-area" | "opened" | "previewed";

export interface FeedbackEvent {
  postId: string;
  subreddit: string;
  action: FeedbackAction;
  at: number;
  match: number | null;
  helpProb: number | null;
  bestCard: string | null;
  /** `${cardId}::${keyword}` pairs that got the post through the prefilter */
  hits: string[];
}

export interface Learned {
  /** Added to the user's base threshold. */
  thresholdDelta: number;
  subredditOffsets: Record<string, number>;
  keywordWeights: Record<string, number>;
  labelled: number;
  updatedAt: number;
}

export const EMPTY_LEARNED: Learned = { thresholdDelta: 0, subredditOffsets: {}, keywordWeights: {}, labelled: 0, updatedAt: 0 };

export const MAX_EVENTS = 2_000;
const MIN_LABELS_FOR_THRESHOLD = 8;
const MIN_LABELS_PER_SUB = 4;
const MAX_THRESHOLD_SHIFT = 0.15;
const MAX_SUB_SHIFT = 0.1;
const KEYWORD_STEP = { answered: 0.25, skipped: -0.15, "not-my-area": -0.35 } as const;

const isPositive = (a: FeedbackAction) => a === "answered";
const isNegative = (a: FeedbackAction) => a === "skipped" || a === "not-my-area";

/** Latest label per post wins, so changing your mind does not double count. */
export function latestLabels(events: FeedbackEvent[]): FeedbackEvent[] {
  const byPost = new Map<string, FeedbackEvent>();
  for (const e of events) {
    if (!isPositive(e.action) && !isNegative(e.action)) continue;
    const prev = byPost.get(e.postId);
    if (!prev || e.at >= prev.at) byPost.set(e.postId, e);
  }
  return [...byPost.values()];
}

export function appendEvent(events: FeedbackEvent[], e: FeedbackEvent): FeedbackEvent[] {
  const next = [...events, e];
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
}

/** Threshold that best separates answered from skipped posts by F1, searched near the base. */
export function refitThreshold(labels: FeedbackEvent[], base: number): number {
  const scored = labels.filter((e) => e.match !== null);
  const pos = scored.filter((e) => isPositive(e.action)).length;
  if (scored.length < MIN_LABELS_FOR_THRESHOLD || pos === 0 || pos === scored.length) return 0;
  let best = { delta: 0, f1: -1 };
  for (let d = -MAX_THRESHOLD_SHIFT; d <= MAX_THRESHOLD_SHIFT + 1e-9; d += 0.05) {
    const t = base + d;
    let tp = 0, fp = 0, fn = 0;
    for (const e of scored) {
      const predicted = (e.match ?? 0) >= t;
      if (predicted && isPositive(e.action)) tp++;
      else if (predicted) fp++;
      else if (isPositive(e.action)) fn++;
    }
    const f1 = tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
    // Prefer the smaller move on ties, so the threshold only drifts on evidence.
    if (f1 > best.f1 + 1e-9 || (Math.abs(f1 - best.f1) < 1e-9 && Math.abs(d) < Math.abs(best.delta))) {
      best = { delta: Math.round(d * 100) / 100, f1 };
    }
  }
  return best.delta;
}

/** Communities where you answer most of what is shown get a lower bar, and vice versa. */
export function subredditOffsets(labels: FeedbackEvent[]): Record<string, number> {
  const counts = new Map<string, { pos: number; all: number }>();
  for (const e of labels) {
    const sub = e.subreddit.toLowerCase();
    const c = counts.get(sub) ?? { pos: 0, all: 0 };
    c.all++;
    if (isPositive(e.action)) c.pos++;
    counts.set(sub, c);
  }
  const out: Record<string, number> = {};
  for (const [sub, c] of counts) {
    if (c.all < MIN_LABELS_PER_SUB) continue;
    const offset = (0.5 - c.pos / c.all) * 2 * MAX_SUB_SHIFT;
    if (Math.abs(offset) >= 0.01) out[sub] = Math.round(offset * 100) / 100;
  }
  return out;
}

export function keywordWeights(labels: FeedbackEvent[]): Record<string, number> {
  const w: Record<string, number> = {};
  for (const e of labels) {
    const step = KEYWORD_STEP[e.action as keyof typeof KEYWORD_STEP];
    if (step === undefined) continue;
    for (const hit of e.hits) {
      const k = hit.toLowerCase();
      w[k] = Math.min(3, Math.max(0, (w[k] ?? 1) + step));
    }
  }
  return w;
}

export function learn(events: FeedbackEvent[], baseThreshold: number, now: number): Learned {
  const labels = latestLabels(events);
  return {
    thresholdDelta: refitThreshold(labels, baseThreshold),
    subredditOffsets: subredditOffsets(labels),
    keywordWeights: keywordWeights(labels),
    labelled: labels.length,
    updatedAt: now,
  };
}

export function effectiveThreshold(base: number, learned: Learned, subreddit: string): number {
  const t = base + learned.thresholdDelta + (learned.subredditOffsets[subreddit.toLowerCase()] ?? 0);
  return Math.min(0.95, Math.max(0.2, t));
}

/** Posts the user marked answered stay hidden even when Reddit's own comment list ages out. */
export function answeredIds(events: FeedbackEvent[]): Set<string> {
  return new Set(latestLabels(events).filter((e) => e.action === "answered").map((e) => e.postId));
}
