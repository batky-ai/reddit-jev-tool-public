// Every Reddit DOM selector and attribute name lives in this file, so a Reddit
// redesign is a one-file fix. Contract confirmed on a live r/n8n feed on
// 2026-09-21 (28/28 posts): `id` (t3_ prefixed) is present, `post-id` is not;
// the feed's text-body holds the full post text (CSS clamps it, the DOM does
// not). Thread HTML carries no comments (they load via a partial), so comments
// come from the thread's .json, never from parsing HTML.

export const POST_SELECTOR = "shreddit-post";
export const BODY_SELECTOR = "shreddit-post-text-body";
export const COMMENT_SELECTOR = "shreddit-comment";

/** Attributes the extractor reads. The spike reports which ones are present. */
export const POST_ATTRS = [
  "id",
  "post-title",
  "permalink",
  "subreddit-prefixed-name",
  "comment-count",
  "created-timestamp",
  "author",
  "post-type",
  "score",
] as const;

export interface FeedPost {
  id: string;
  title: string;
  body: string;
  permalink: string;
  subreddit: string;
  commentCount: number;
  createdAt: number | null;
  author: string;
  flair: string;
}

/** Feed pages get post highlights; thread pages (`/comments/`) get comment scanning instead. */
export function isFeedPath(pathname: string): boolean {
  return !pathname.includes("/comments/");
}

/** The visual card around a post. Highlights attach here, not to the custom element. */
export function cardFor(post: Element): Element {
  return post.closest("article") ?? post;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

const BLOCKS = "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, tr";

/** Text with one line per block element; textContent alone glues `<p>a</p><p>b</p>` into "ab". */
function blockText(el: Element | null | undefined): string {
  if (!el) return "";
  const clone = el.cloneNode(true) as Element;
  for (const b of clone.querySelectorAll(BLOCKS)) b.append("\n");
  return (clone.textContent ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function postId(post: Element): string {
  const raw = post.getAttribute("id") ?? "";
  return raw.replace(/^t3_/, "");
}

export function extractPost(post: Element): FeedPost | null {
  const id = postId(post);
  const permalink = post.getAttribute("permalink") ?? "";
  if (!id || !permalink) return null;
  const card = cardFor(post);
  // Feed cards use <shreddit-post-text-body>; on thread pages the body may be a
  // plain [slot=text-body] element (fallback not yet confirmed by diagnostics).
  const body =
    blockText(post.querySelector(BODY_SELECTOR)) ||
    blockText(card.querySelector(BODY_SELECTOR)) ||
    blockText(post.querySelector('[slot="text-body"]'));
  const created = Date.parse(post.getAttribute("created-timestamp") ?? "");
  const flair = text(post.querySelector("shreddit-post-flair, flair-tag, [slot='post-flair']"));
  return {
    id,
    title: post.getAttribute("post-title") ?? text(post.querySelector("[slot='title']")),
    body,
    permalink,
    subreddit: (post.getAttribute("subreddit-prefixed-name") ?? "").replace(/^r\//, ""),
    commentCount: Number(post.getAttribute("comment-count") ?? 0) || 0,
    createdAt: Number.isNaN(created) ? null : created,
    author: post.getAttribute("author") ?? "",
    flair,
  };
}

// ---- thread pages ----
// Contract from the live thread diagnostics (2026-09-21, 15/15 comments):
// <shreddit-comment thingid="t1_x" author depth permalink postid score created>,
// `parentid` only on replies, `collapsed` when folded, `is-mod-distinguished`
// on moderator/bot comments. Light DOM, no shadow root. Replies are nested
// inside their parent, so the body is found by its id, never by a generic
// `[slot=comment]` query that would also match nested replies.

export interface ThreadComment {
  id: string; // without t1_
  author: string;
  depth: number;
  parentId: string | null; // without t1_, null for top-level
  permalink: string;
  score: number;
  body: string;
  collapsed: boolean;
  moderator: boolean;
}

const THING_ID = /^t1_[a-z0-9]+$/i; // validated before use in selectors

export function commentBodyElement(comment: Element): Element | null {
  const thingid = comment.getAttribute("thingid") ?? "";
  if (!THING_ID.test(thingid)) return null;
  return thingid ? comment.querySelector(`[id="${thingid}-comment-rtjson-content"]`) : null;
}

export function extractComment(comment: Element): ThreadComment | null {
  const thingid = comment.getAttribute("thingid") ?? "";
  if (!thingid.startsWith("t1_")) return null;
  const parent = comment.getAttribute("parentid");
  return {
    id: thingid.slice(3),
    author: comment.getAttribute("author") ?? "",
    depth: Number(comment.getAttribute("depth") ?? 0) || 0,
    parentId: parent?.startsWith("t1_") ? parent.slice(3) : null,
    permalink: comment.getAttribute("permalink") ?? "",
    score: Number(comment.getAttribute("score") ?? 0) || 0,
    body: blockText(commentBodyElement(comment)),
    collapsed: comment.hasAttribute("collapsed"),
    moderator: comment.hasAttribute("is-mod-distinguished"),
  };
}

/** Reddit's own Reply button for exactly this comment (not a nested one). */
export function replyButtonFor(comment: Element): HTMLElement | null {
  const thingid = comment.getAttribute("thingid") ?? "";
  if (!THING_ID.test(thingid)) return null;
  const row = comment.querySelector(`shreddit-comment-action-row[comment-id="${thingid}"]`);
  return row?.querySelector<HTMLElement>('[noun="reply_comment"] button, button[slot="comment-reply"]') ?? null;
}

/** The post id on a thread page, from the URL (`/r/x/comments/<id>/...`). */
export function threadPostId(pathname: string): string | null {
  return pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1] ?? null;
}

/** Absolute URL for a permalink on the current origin. */
export function threadUrl(permalink: string, origin = location.origin): string {
  return new URL(permalink, origin).toString();
}
