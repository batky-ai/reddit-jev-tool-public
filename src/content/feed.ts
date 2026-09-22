// Watches the feed for post cards and scores the ones near the viewport.
// Scoring reads only what the page already rendered. The only Reddit requests
// here are the identity and your recent comments (cached, one each per 30
// minutes at most) so threads you already answered stay out of the way.

import { answeredIds, effectiveThreshold, EMPTY_LEARNED, type FeedbackAction, type Learned } from "../core/learning";
import { parseCards, formatCards } from "../core/cards";
import { prefilter } from "../core/prefilter";
import { boostedMatch, tierFor } from "../jev/client";
import { POST_SELECTOR, cardFor, extractPost, isFeedPath } from "../reddit/adapter";
import { createRedditClient, type RedditClient } from "../reddit/client";
import { loadFeedback, loadLearned, recordFeedback } from "../shared/feedback";
import { sendToWorker } from "../shared/messaging";
import { loadCards, loadSettings, saveCards } from "../shared/settings";
import type { Card, ScoreRequestMessage, ScoreResponse, Settings } from "../shared/types";
import { applyReplied, applyVerdict, clearMark, dismiss, markPending, showNotice } from "./highlight";
import { openPreview } from "./preview";

let settings: Settings;
let cards: Card[] = [];
let learned: Learned = EMPTY_LEARNED;
let answered = new Set<string>();
let client: RedditClient;
let identity: Promise<{ me: string | null; replied: Set<string> }>;
const seen = new WeakSet<Element>();
const retries = new WeakMap<Element, number>();
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;

/**
 * What happened to every post this page load. Shown in the feed status pill so
 * "badges stopped" can be traced to a cause (Evan, 2026-09-22): archived, no card
 * overlap, Jev errors, or an exception.
 */
export const stats = {
  checked: 0,
  highlighted: 0,
  scoredNone: 0,
  replied: 0,
  skipped: {} as Record<string, number>,
  errors: 0,
  lastError: "",
};

async function refreshConfig(): Promise<void> {
  const [s, c, l, events] = await Promise.all([loadSettings(), loadCards(), loadLearned(), loadFeedback()]);
  settings = s;
  cards = c;
  learned = l;
  answered = answeredIds(events);
}

const storageKV = {
  async get(key: string) {
    return (await chrome.storage.local.get(key))[key];
  },
  async set(key: string, value: unknown) {
    await chrome.storage.local.set({ [key]: value });
  },
};

async function loadIdentity(): Promise<{ me: string | null; replied: Set<string> }> {
  try {
    const me = await client.username();
    return { me, replied: me ? await client.repliedThreads() : new Set() };
  } catch {
    return { me: null, replied: new Set() }; // logged out or rate limited: just don't hide anything
  }
}

async function addCard(input: { title: string; keywords: string; summary: string }): Promise<void> {
  const md = `${formatCards(await loadCards())}\n\n## ${input.title.trim()}\nkeywords: ${input.keywords}\n${input.summary.trim()}`;
  await saveCards(parseCards(md));
}

function skip(reason: string): void {
  stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
  renderStatus();
}

function fail(error: string): void {
  stats.errors++;
  stats.lastError = error.slice(0, 120);
  renderStatus();
}

async function processPost(el: Element): Promise<void> {
  if (!isFeedPath(location.pathname)) return;
  try {
    await scorePost(el);
  } catch (e) {
    // Never let one post's exception go silent: count it and show it.
    clearMark(el);
    fail(`exception: ${(e as Error).message}`);
  }
}

async function scorePost(el: Element): Promise<void> {
  const post = extractPost(el);
  if (!post) return skip("unreadable card");
  stats.checked++;

  const { me, replied } = await identity;
  if (me && post.author === me) {
    stats.replied++;
    return applyReplied(el, "Your post");
  }
  if (replied.has(post.id) || answered.has(post.id)) {
    stats.replied++;
    return applyReplied(el, "You replied");
  }

  const pre = prefilter(post, cards, settings, { weights: learned.keywordWeights });
  if (!pre.pass) {
    if (pre.rejection === "no cards") showNotice("add expertise cards in the extension options to start highlighting.");
    return skip(pre.rejection ?? "filtered");
  }
  markPending(el);
  const msg: ScoreRequestMessage = { type: "score", post, cards: pre.candidates };
  const res: ScoreResponse = await sendToWorker(msg);
  if (!res.ok) {
    clearMark(el);
    fail(res.error);
    if (!res.retryable) return showNotice(res.error);
    // Retry: re-observe so the post is scored again when it is (still) on screen.
    const n = (retries.get(el) ?? 0) + 1;
    retries.set(el, n);
    if (n <= MAX_RETRIES) setTimeout(() => visibility.observe(el), RETRY_DELAY_MS * n);
    return;
  }
  const verdict = res.verdict;
  const threshold = effectiveThreshold(settings.threshold, learned, post.subreddit);
  const ranked = boostedMatch(verdict.match, post.commentCount, threshold, settings.unansweredBoost);
  const tier = tierFor({ helpProb: verdict.helpProb, match: ranked }, threshold);
  if (tier === "none") stats.scoredNone++;
  else stats.highlighted++;
  renderStatus();

  const feedback = (action: FeedbackAction) => {
    void recordFeedback({
      postId: post.id,
      subreddit: post.subreddit,
      action,
      at: Date.now(),
      match: verdict.match,
      helpProb: verdict.helpProb,
      bestCard: verdict.bestCard,
      hits: pre.hits,
    });
    if (action === "answered") {
      answered.add(post.id);
      void client.markReplied(post.id);
      applyReplied(el, "You answered");
    } else if (action === "skipped" || action === "not-my-area") {
      dismiss(el);
    }
  };

  applyVerdict(el, tier, verdict, ranked, post.commentCount, pre.candidates, () =>
    openPreview(
      { post, verdict, ranked, tier, threshold, cards: pre.candidates },
      {
        client,
        assess: (m) => sendToWorker(m),
        feedback,
        addCard,
        replied: (id) => answered.has(id),
      },
    ),
  );
}

const visibility = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      visibility.unobserve(e.target);
      void processPost(e.target);
    }
  },
  { rootMargin: "600px 0px" },
);

function track(root: ParentNode): void {
  const found = root instanceof Element && root.matches(POST_SELECTOR) ? [root] : [];
  for (const el of [...found, ...root.querySelectorAll(POST_SELECTOR)]) {
    if (seen.has(el)) continue;
    seen.add(el);
    visibility.observe(el);
  }
}

const STATUS_ID = "rjt-feed-status";

function statusText(): { short: string; detail: string } {
  const skipped = Object.entries(stats.skipped).sort((a, b) => b[1] - a[1]);
  const short = `Jev · ${stats.highlighted} highlighted of ${stats.checked} checked${stats.errors ? ` · ${stats.errors} error${stats.errors === 1 ? "" : "s"}` : ""}`;
  const detail = [
    `Highlighted: ${stats.highlighted}`,
    `Scored, below the bar: ${stats.scoredNone}`,
    `Already replied / your posts: ${stats.replied}`,
    ...skipped.map(([reason, n]) => `Skipped, ${reason}: ${n}`),
    stats.errors ? `Errors: ${stats.errors} (last: ${stats.lastError})` : "Errors: 0",
  ].join("\n");
  return { short, detail };
}

function renderStatus(): void {
  if (!isFeedPath(location.pathname) || typeof document === "undefined") return;
  let pill = document.getElementById(STATUS_ID);
  if (!pill) {
    pill = document.createElement("button");
    pill.id = STATUS_ID;
    pill.addEventListener("click", () => {
      pill!.classList.toggle("open");
      renderStatus();
    });
    document.body.append(pill);
  }
  const { short, detail } = statusText();
  pill.dataset.errors = stats.errors ? "true" : "false";
  pill.textContent = pill.classList.contains("open") ? `${short}\n\n${detail}` : short;
  pill.title = detail;
}

/**
 * Re-checks posts that carry no mark. Called after in-app navigation back to a
 * feed: Reddit can reuse or re-render post elements, which drops our badges
 * while the element still counts as seen.
 */
export function rescanFeed(): void {
  if (!isFeedPath(location.pathname)) return;
  for (const el of document.querySelectorAll(POST_SELECTOR)) {
    const card = cardFor(el);
    if (card.hasAttribute("data-rjt-tier") || card.hasAttribute("data-rjt-state")) continue;
    seen.delete(el);
  }
  track(document);
}

/** Starts watching the feed. Returns a function that stops all observers. */
export async function startFeed(redditClient?: RedditClient): Promise<() => void> {
  client =
    redditClient ??
    createRedditClient({
      fetch: (u, i) => fetch(u, i),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      origin: location.origin,
      store: storageKV,
    });
  await refreshConfig();
  identity = settings.enabled ? loadIdentity() : Promise.resolve({ me: null, replied: new Set() });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.settings || changes.cards || changes.learned || changes.feedback)) void refreshConfig();
  });
  track(document);
  const mutations = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) track(n);
  });
  // documentElement, not body: the observer must survive Reddit swapping <body>.
  mutations.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    mutations.disconnect();
    visibility.disconnect();
  };
}
