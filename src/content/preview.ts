// The side panel that lets you read a post and its top comments before
// opening the thread. One Reddit request (the thread's .json) and one Jev
// tier 2 call per preview, both cached. All Reddit text is set with
// textContent, never innerHTML.

import type { FeedbackAction } from "../core/learning";
import { helpSignal } from "../core/prefilter";
import { RedditError, type RedditClient, type Thread } from "../reddit/client";
import { threadUrl } from "../reddit/adapter";
import type { AssessRequestMessage, AssessResponse, Card, FeedPost, Tier, Tier1Verdict } from "../shared/types";

export interface PreviewContext {
  post: FeedPost;
  verdict: Tier1Verdict;
  /** Match after the unanswered boost; equals verdict.match when no boost applied. */
  ranked: number;
  tier: Tier;
  threshold: number;
  cards: Card[];
}

export interface PreviewDeps {
  client: RedditClient;
  assess(msg: AssessRequestMessage): Promise<AssessResponse>;
  feedback(action: FeedbackAction): void;
  addCard(card: { title: string; keywords: string; summary: string }): Promise<void>;
  replied(postId: string): boolean;
}

const PANEL_ID = "rjt-panel";
const SOLVED = /\b(solved|resolved|answered|fixed)\b/i;
/** Jev "gap" probability at which a comment is marked. Set from 16 synthetic comments (gaps 0.83+, noise up to 0.74); watch it in real use. */
export const VALUE_THRESHOLD = 0.8;

/**
 * Softer tier for the single best comment when nothing clears the bar. On real
 * r/n8n threads (2026-09-22) gap scores topped out at 0.53-0.76 because comments
 * are mostly partial answers, so a 0.8-only rule marked almost nothing.
 */
export const SOFT_THRESHOLD = 0.6;

type ThreadCommentView = Thread["comments"][number];

export interface Recommendation {
  kind: "op-followup" | "comment" | "maybe" | "post" | "answered" | "unknown";
  text: string;
  targets: ThreadCommentView[];
}

/** The single answer to "where should I comment?", in order of confidence. */
export function whereToComment(
  comments: ThreadCommentView[],
  verdict: { valueProbs?: Record<string, number>; answeredProb: number; stillNeedsProb?: number } | null,
): Recommendation {
  const followUps = comments.filter(isUnansweredOpFollowUp);
  if (followUps.length) {
    return { kind: "op-followup", text: "Reply to the original poster's unanswered follow-up question.", targets: followUps };
  }
  if (!verdict) {
    return comments.length
      ? { kind: "unknown", text: "Couldn't judge the comments. Open the thread and read them.", targets: [] }
      : { kind: "post", text: "No comments yet. You would be the first to reply to the post.", targets: [] };
  }
  const probs = verdict.valueProbs ?? {};
  const ranked = comments
    .map((c) => ({ c, p: probs[c.id] ?? 0 }))
    .sort((a, b) => b.p - a.p);
  const strong = ranked.filter((r) => r.p >= VALUE_THRESHOLD).map((r) => r.c);
  if (strong.length) {
    return { kind: "comment", text: `Reply to ${strong.length === 1 ? "this comment" : `these ${strong.length} comments`}: an open question or wrong advice you can fix.`, targets: strong };
  }
  const best = ranked[0];
  if (best && best.p >= SOFT_THRESHOLD) {
    return { kind: "maybe", text: `No clear gap, but you could add to this comment (${Math.round(best.p * 100)}%).`, targets: [best.c] };
  }
  const top = Math.round((best?.p ?? 0) * 100);
  if (verdict.answeredProb >= 0.6) {
    return { kind: "answered", text: `The post already looks answered, and no comment leaves a gap (highest ${top}%). Probably skip.`, targets: [] };
  }
  // e.g. "Already fixed this, just sharing" (live r/n8n thread, stillNeeds 0.06).
  if (verdict.stillNeedsProb !== undefined && verdict.stillNeedsProb <= 0.15) {
    return { kind: "answered", text: `The original poster doesn't seem to need help anymore (highest comment gap ${top}%). Reply only if you have something new to add.`, targets: [] };
  }
  return { kind: "post", text: `Reply to the post itself: no comment leaves a gap you'd fill (highest ${top}%).`, targets: [] };
}

/** OP asked something in the comments and nobody has replied to it: the cheapest, highest-value signal. */
export function isUnansweredOpFollowUp(c: Pick<Thread["comments"][number], "isOp" | "replyCount" | "body">): boolean {
  if (!c.isOp || c.replyCount > 0) return false;
  return helpSignal({ title: c.body.split("\n")[0] ?? "", body: c.body, flair: "" }).isLikelyHelp;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function chip(text: string, kind: "neutral" | "good" | "warn" = "neutral"): HTMLElement {
  const c = el("span", `rjt-chip rjt-chip-${kind}`, text);
  return c;
}

export function closePreview(): void {
  document.getElementById(PANEL_ID)?.remove();
}

export function openPreview(ctx: PreviewContext, deps: PreviewDeps): HTMLElement {
  closePreview();
  const { post, verdict } = ctx;
  const panel = el("aside");
  panel.id = PANEL_ID;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Post preview");

  const head = el("div", "rjt-head");
  head.append(el("span", "rjt-sub", `r/${post.subreddit}`));
  const close = el("button", "rjt-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close preview");
  close.onclick = closePreview;
  head.append(close);

  const matched = ctx.cards.find((c) => c.id === verdict.bestCard)?.title;
  const summary = el(
    "p",
    "rjt-meta",
    `Match ${Math.round(verdict.match * 100)}%` +
      (ctx.ranked > verdict.match ? ` +${Math.round((ctx.ranked - verdict.match) * 100)}% unanswered` : "") +
      ` (threshold ${Math.round(ctx.threshold * 100)}%)${matched ? ` · ${matched}` : ""}`,
  );

  const title = el("h2", "rjt-title", post.title);
  const body = el("div", "rjt-body", post.body.slice(0, 3000) || "(no text, link or media post)");
  const where = el("div", "rjt-where");
  where.append(el("strong", undefined, "Where to comment"), el("p", undefined, "Checking the comments…"));
  const chips = el("div", "rjt-chips");
  chips.append(chip("Loading comments…"));
  if (SOLVED.test(post.flair)) chips.append(chip(`Flair: ${post.flair}`, "warn"));
  if (deps.replied(post.id)) chips.append(chip("You replied", "warn"));

  const actions = el("div", "rjt-actions");
  const open = el("a", "rjt-btn rjt-primary", "Open thread");
  open.href = threadUrl(post.permalink);
  open.onclick = () => deps.feedback("opened");
  const btn = (label: string, action: FeedbackAction) => {
    const b = el("button", "rjt-btn", label);
    b.type = "button";
    b.onclick = () => {
      deps.feedback(action);
      if (action === "answered" && (!verdict.bestCard || verdict.match < ctx.threshold)) showAddCard(panel, deps);
      else closePreview();
    };
    return b;
  };
  actions.append(open, btn("I answered", "answered"), btn("Skip", "skipped"), btn("Not my area", "not-my-area"));

  const comments = el("section", "rjt-comments");
  comments.append(el("h3", undefined, `Top comments (${post.commentCount})`));

  panel.append(head, summary, title, where, body, chips, actions, comments);
  document.body.append(panel);
  deps.feedback("previewed");
  void loadComments(ctx, deps, chips, comments);
  return panel;
}

function renderWhere(panel: HTMLElement, rec: Recommendation, postPermalink: string): void {
  const box = panel.querySelector<HTMLElement>(".rjt-where");
  if (!box) return;
  box.dataset.kind = rec.kind;
  box.replaceChildren(el("strong", undefined, "Where to comment"), el("p", undefined, rec.text));
  const links = el("div", "rjt-where-links");
  for (const t of rec.targets.slice(0, 3)) {
    const a = el("a", "rjt-reply", `Reply to: “${t.body.replace(/\s+/g, " ").slice(0, 60)}${t.body.length > 60 ? "…" : ""}” ▸`);
    a.href = threadUrl(t.permalink);
    links.append(a);
  }
  if (rec.kind === "post") {
    const a = el("a", "rjt-reply", "Reply to the post ▸");
    a.href = threadUrl(postPermalink);
    links.append(a);
  }
  if (links.childElementCount) box.append(links);
}

async function loadComments(ctx: PreviewContext, deps: PreviewDeps, chips: HTMLElement, list: HTMLElement): Promise<void> {
  const panel = list.closest<HTMLElement>(`#${PANEL_ID}`)!;
  let thread: Thread;
  try {
    thread = await deps.client.thread(ctx.post.permalink);
  } catch (e) {
    renderWhere(panel, { kind: "unknown", text: "Couldn't load the comments. Open the thread to decide.", targets: [] }, ctx.post.permalink);
    chips.firstChild?.remove();
    const status = e instanceof RedditError ? e.status : undefined;
    const paused = deps.client.pausedUntil - Date.now();
    chips.prepend(
      chip(
        status === 401 || status === 403
          ? "Log in to Reddit to see comments"
          : paused > 0
            ? `Reddit rate limit: comments paused ${Math.ceil(paused / 1000)}s`
            : "Comments unavailable",
        "warn",
      ),
    );
    return;
  }
  chips.firstChild?.remove();
  if (thread.flair && SOLVED.test(thread.flair) && !SOLVED.test(ctx.post.flair)) chips.prepend(chip(`Flair: ${thread.flair}`, "warn"));
  if (thread.locked) chips.prepend(chip("Locked", "warn"));

  if (thread.comments.length === 0) list.append(el("p", "rjt-meta", "No comments yet. You would be first."));
  const items = new Map<string, HTMLElement>();
  for (const c of thread.comments) {
    const item = el("article", "rjt-comment");
    const meta = el("div", "rjt-meta", `${c.score} pts${c.replyCount ? ` · ${c.replyCount} replies` : ""}`);
    if (c.isOp) meta.prepend(chip("OP", "good"));
    if (isUnansweredOpFollowUp(c)) {
      meta.prepend(chip("OP follow-up unanswered", "good"));
      addReplyLink(item, c.permalink);
    }
    item.prepend(meta);
    item.append(el("p", undefined, c.body));
    list.append(item);
    items.set(c.id, item);
  }
  if (thread.comments.some(isUnansweredOpFollowUp)) chips.append(chip("OP has an unanswered follow-up", "good"));
  if (thread.comments.length === 0) {
    renderWhere(panel, whereToComment([], null), ctx.post.permalink);
    return;
  }

  const pending = chip("Checking answers…");
  chips.append(pending);
  const res = await deps.assess({
    type: "assess",
    post: ctx.post,
    comments: thread.comments.map(({ id, body, score, isOp, replyCount }) => ({ id, body, score, isOp, replyCount })),
    cards: ctx.cards,
  });
  pending.remove();
  if (!res.ok) {
    chips.append(chip(`Jev: ${res.error}`, "warn"));
    renderWhere(panel, whereToComment(thread.comments, null), ctx.post.permalink);
    return;
  }
  const rec = whereToComment(thread.comments, res.verdict);
  renderWhere(panel, rec, ctx.post.permalink);
  const a = Math.round(res.verdict.answeredProb * 100);
  const n = Math.round(res.verdict.stillNeedsProb * 100);
  chips.append(
    chip(`Already answered ${a}%`, a >= 60 ? "warn" : "neutral"),
    chip(`OP still needs help ${n}%`, n >= 60 ? "good" : "neutral"),
  );

  // Mark the recommended comments in the list too, strongest first.
  let places = 0;
  for (const c of rec.kind === "comment" || rec.kind === "maybe" ? rec.targets : []) {
    const item = items.get(c.id);
    const p = res.verdict.valueProbs?.[c.id] ?? 0;
    if (!item) continue;
    places++;
    item.classList.add("rjt-value");
    item.querySelector(".rjt-meta")?.prepend(
      chip(rec.kind === "comment" ? `Good place to reply ${Math.round(p * 100)}%` : `Could add to this ${Math.round(p * 100)}%`, "good"),
    );
    addReplyLink(item, c.permalink);
  }
  if (places) {
    chips.append(chip(`${places} place${places === 1 ? "" : "s"} to add value`, "good"));
    // Valuable comments first, right under the heading, keeping their score order.
    list.querySelector("h3")?.after(...list.querySelectorAll(".rjt-value"));
  }
}

function addReplyLink(item: HTMLElement, permalink: string): void {
  if (!permalink || item.querySelector(".rjt-reply")) return;
  const a = el("a", "rjt-reply", "Reply here ▸");
  a.href = threadUrl(permalink);
  item.append(a);
}

function showAddCard(panel: HTMLElement, deps: PreviewDeps): void {
  const form = el("form", "rjt-addcard");
  form.append(el("p", undefined, "None of your cards covered this. Add one so similar posts get found?"));
  const title = el("input");
  title.placeholder = "Card title, e.g. WhatsApp Business API";
  title.required = true;
  const keywords = el("input");
  keywords.placeholder = "keywords, comma separated";
  const summary = el("textarea");
  summary.placeholder = "What you know about it, in a sentence or two";
  const save = el("button", "rjt-btn rjt-primary", "Save card");
  save.type = "submit";
  const skip = el("button", "rjt-btn", "No thanks");
  skip.type = "button";
  skip.onclick = closePreview;
  form.append(title, keywords, summary, save, skip);
  form.onsubmit = async (e) => {
    e.preventDefault();
    await deps.addCard({ title: title.value, keywords: keywords.value, summary: summary.value });
    closePreview();
  };
  panel.querySelector(".rjt-actions")?.after(form);
  title.focus();
}
