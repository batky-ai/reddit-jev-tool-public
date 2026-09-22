// Thread mode: on a thread page, find comments where the user could add value
// and mark them in place. Reads only the comments Reddit already rendered, so
// it makes no Reddit requests. Jev calls are batched (up to 15 comments each)
// and capped per thread.

import { batches, selectCandidates, type CommentCandidate } from "../core/comments";
import { EMPTY_LEARNED, type Learned } from "../core/learning";
import { rankCards } from "../core/prefilter";
import {
  COMMENT_SELECTOR,
  POST_SELECTOR,
  commentBodyElement,
  extractComment,
  extractPost,
  isFeedPath,
  replyButtonFor,
  threadPostId,
} from "../reddit/adapter";
import type { RedditClient } from "../reddit/client";
import { loadLearned } from "../shared/feedback";
import { sendToWorker } from "../shared/messaging";
import { loadCards, loadSettings } from "../shared/settings";
import type { AssessRequestMessage, AssessResponse, Card, FeedPost, Settings } from "../shared/types";
import { SOFT_THRESHOLD, VALUE_THRESHOLD } from "./preview";

const BADGE = "rjt-comment-badge";
const PILL_ID = "rjt-thread-pill";
const DEBOUNCE_MS = 800;
/** Wait for this many new candidates before calling Jev, unless scrolling has stopped. */
const MIN_BATCH = 6;
const IDLE_FLUSH_MS = 2500;
/**
 * Budget per thread, counted in comments judged, not calls: counting calls let a
 * few small scroll-triggered batches exhaust a thread (Evan, 2026-09-22).
 */
export const MAX_JUDGED_PER_THREAD = 45;

interface ThreadState {
  postId: string;
  sent: Set<string>; // comment ids judged or flagged successfully
  judged: number;
  marks: Element[];
  lastError: string | null;
  lastErrorAt: number;
  /** Highest gap probability seen, so a miss can be told apart from a bug. */
  topGap: number;
}

let settings: Settings;
let cards: Card[] = [];
let learned: Learned = EMPTY_LEARNED;
let state: ThreadState | null = null;
const visible = new WeakSet<Element>(); // weak: comments from earlier threads can be collected
let timer: ReturnType<typeof setTimeout> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let running = false;

async function refreshConfig(): Promise<void> {
  [settings, cards, learned] = await Promise.all([loadSettings(), loadCards(), loadLearned()]);
}

function threadPost(postId: string): FeedPost {
  const el = document.querySelector(POST_SELECTOR);
  return (
    (el && extractPost(el)) ?? {
      id: postId,
      title: document.title,
      body: "",
      permalink: location.pathname,
      subreddit: location.pathname.split("/")[2] ?? "",
      commentCount: 0,
      createdAt: null,
      author: "",
      flair: "",
    }
  );
}

function badge(commentEl: Element, text: string, kind: "value" | "followup" | "maybe"): void {
  const body = commentBodyElement(commentEl);
  if (!body || body.parentElement?.querySelector(`:scope > .${BADGE}`)) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = BADGE;
  b.dataset.kind = kind;
  b.textContent = `${text} · reply ▸`;
  b.title = "Opens Reddit's reply box for this comment";
  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const reply = replyButtonFor(commentEl);
    if (reply) reply.click();
    else commentEl.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  body.classList.add("rjt-comment-value");
  body.after(b);
  state?.marks.push(commentEl);
  renderPill();
}

function pillText(s: ThreadState): string {
  const count = s.marks.length;
  const main = count
    ? `${count} place${count === 1 ? "" : "s"} you could help ▸`
    : `No open gaps found yet${s.judged ? ` (highest ${Math.round(s.topGap * 100)}%, bar ${Math.round(VALUE_THRESHOLD * 100)}%)` : ""}`;
  const detail = s.lastError
    ? `Jev: ${s.lastError}`
    : `checked ${s.judged} comment${s.judged === 1 ? "" : "s"}${s.judged >= MAX_JUDGED_PER_THREAD ? " (thread budget used)" : ""}`;
  return `${main} · ${detail}`;
}

function renderPill(): void {
  const s = state;
  let pill = document.getElementById(PILL_ID);
  if (!s || (!s.marks.length && !s.judged && !s.lastError)) {
    pill?.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement("button");
    pill.id = PILL_ID;
    let next = 0;
    pill.addEventListener("click", () => {
      const marks = state?.marks ?? [];
      if (!marks.length) return;
      marks[next % marks.length]!.scrollIntoView({ behavior: "smooth", block: "center" });
      next++;
    });
    document.body.append(pill);
  }
  pill.textContent = pillText(s);
  pill.dataset.empty = s.marks.length ? "false" : "true";
}

function reset(postId: string): void {
  for (const b of document.querySelectorAll(`.${BADGE}`)) b.remove();
  document.getElementById(PILL_ID)?.remove();
  state = { postId, sent: new Set(), judged: 0, marks: [], lastError: null, lastErrorAt: 0, topGap: 0 };
}

/** Cards relevant to this thread: the ones whose keywords appear in the post or candidates. */
function threadCards(post: FeedPost, candidates: CommentCandidate[]): Card[] {
  const text = { title: post.title, body: `${post.body}\n${candidates.map((c) => c.comment.body).join("\n")}` };
  const ranked = rankCards(text, cards, learned.keywordWeights).slice(0, 5).map((m) => m.card);
  return ranked.length || !settings.scoreWithoutKeywords ? ranked : cards.slice(0, 5);
}

export async function scanThread(
  me: string | null,
  send: (m: AssessRequestMessage) => Promise<AssessResponse>,
  opts: { flush?: boolean; onDeferred?: () => void } = {},
): Promise<void> {
  if (isFeedPath(location.pathname) || !settings?.enabled || !settings.scanThreads || cards.length === 0) return;
  const postId = threadPostId(location.pathname);
  if (!postId) return;
  if (state?.postId !== postId) reset(postId);
  const s = state!;

  const all = [...document.querySelectorAll(COMMENT_SELECTOR)];
  const byId = new Map<string, Element>();
  const comments = all.flatMap((el) => {
    const c = extractComment(el);
    if (c) byId.set(c.id, el);
    return c ? [c] : [];
  });
  const post = threadPost(postId);
  const fresh = selectCandidates(comments, { me, opAuthor: post.author, cards, weights: learned.keywordWeights }).filter(
    (c) => !s.sent.has(c.comment.id) && visible.has(byId.get(c.comment.id)!),
  );
  if (!fresh.length) return;

  // Free signal first: OP asked something nobody answered.
  for (const c of fresh.filter((c) => c.opFollowUp)) {
    s.sent.add(c.comment.id);
    badge(byId.get(c.comment.id)!, "OP follow-up unanswered", "followup");
  }

  const remaining = MAX_JUDGED_PER_THREAD - s.judged;
  const toJudge = fresh.filter((c) => !c.opFollowUp).slice(0, Math.max(0, remaining));
  const relevant = threadCards(post, toJudge);
  if (!toJudge.length || !relevant.length || !settings.apiKey) return;
  // After a failure, wait before re-sending the same comments (callJev already retried).
  if (s.lastError && Date.now() - s.lastErrorAt < 30_000) return;
  // Small trickles wait for more comments to scroll in, then flush once scrolling stops.
  if (toJudge.length < MIN_BATCH && !opts.flush) {
    opts.onDeferred?.();
    return;
  }
  for (const batch of batches(toJudge)) {
    const res = await send({
      type: "assess",
      post,
      comments: batch.map((c) => ({ id: c.comment.id, body: c.comment.body.slice(0, 600), score: c.comment.score, isOp: c.isOp, replyCount: c.replyCount })),
      cards: relevant,
    });
    if (state !== s) return; // navigated to another thread
    if (!res.ok) {
      s.lastError = res.error; // not marked sent: retried on a later scan
      s.lastErrorAt = Date.now();
      renderPill();
      return;
    }
    s.lastError = null;
    s.judged += batch.length;
    let best: { c: CommentCandidate; p: number } | null = null;
    let strong = 0;
    for (const c of batch) {
      s.sent.add(c.comment.id);
      const p = res.verdict.valueProbs?.[c.comment.id];
      if (p === undefined) continue;
      s.topGap = Math.max(s.topGap, p);
      if (!best || p > best.p) best = { c, p };
      if (p >= VALUE_THRESHOLD) {
        strong++;
        badge(byId.get(c.comment.id)!, `Good place to reply ${Math.round(p * 100)}%`, "value");
      }
    }
    // Real threads rarely clear 0.8, so the best comment of a batch still gets a softer mark.
    if (!strong && best && best.p >= SOFT_THRESHOLD) {
      badge(byId.get(best.c.comment.id)!, `Could add to this ${Math.round(best.p * 100)}%`, "maybe");
    }
    renderPill();
  }
}

/** Starts thread mode. Returns a function that stops its observers. */
export async function startThread(client: RedditClient): Promise<() => void> {
  await refreshConfig();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.settings || changes.cards || changes.learned)) void refreshConfig();
  });
  const send = (m: AssessRequestMessage) => sendToWorker(m);
  // One scan at a time: overlapping scans could both pass the budget check.
  const run = async (flush: boolean) => {
    if (isFeedPath(location.pathname)) return;
    if (running) return schedule();
    running = true;
    try {
      const me = await client.username().catch(() => null);
      await scanThread(me, send, {
        flush,
        onDeferred: () => {
          clearTimeout(flushTimer);
          flushTimer = setTimeout(() => void run(true), IDLE_FLUSH_MS);
        },
      });
    } finally {
      running = false;
    }
  };
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(false), DEBOUNCE_MS);
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) visible.add(e.target);
      schedule();
    },
    { rootMargin: "400px 0px" },
  );
  const track = (root: ParentNode) => {
    const found = root instanceof Element && root.matches(COMMENT_SELECTOR) ? [root] : [];
    for (const el of [...found, ...root.querySelectorAll(COMMENT_SELECTOR)]) io.observe(el);
  };
  track(document);
  const mo = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) track(n);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    mo.disconnect();
    io.disconnect();
    clearTimeout(timer);
    clearTimeout(flushTimer);
  };
}
