// Thread-page diagnostics: records how Reddit renders comments on a thread page
// so thread-mode scanning is built on the real DOM, not on recall. Reads the
// page only; makes no network requests. The report is redacted before storage.

import { BODY_SELECTOR, COMMENT_SELECTOR, POST_SELECTOR, extractPost } from "../reddit/adapter";
import { redactCard } from "./redact";

export interface ThreadDiagnostics {
  version: 1;
  ranAt: string;
  page: string;
  commentCount: number;
  /** attribute name -> how many of the first 20 comments carry it */
  attrPresence: Record<string, number>;
  /** direct children of the first comment: tag and slot, to locate the body text */
  firstCommentChildren: Array<{ tag: string; slot: string | null; textLength: number }>;
  treeContainer: boolean;
  loadMoreControls: number;
  shadowRoot: boolean;
  /** The post element on a thread page: OP detection reads its author attribute. */
  post: { present: boolean; attrs: string[]; bodyElement: string | null; textLength: number };
  fixtures: string[];
}

const SAMPLE = 20;
const FIXTURE_CAP = 20_000;

/** One comment without its nested replies, redacted. */
function commentFixture(comment: Element, hide: string[]): string {
  const clone = comment.cloneNode(true) as Element;
  for (const nested of clone.querySelectorAll(COMMENT_SELECTOR)) nested.remove();
  return redactCard(clone, hide).slice(0, FIXTURE_CAP);
}

export function runThreadDiagnostics(doc: Document = document, hide: string[] = []): ThreadDiagnostics {
  const comments = [...doc.querySelectorAll(COMMENT_SELECTOR)];
  const sample = comments.slice(0, SAMPLE);
  const attrPresence: Record<string, number> = {};
  for (const c of sample) for (const a of c.getAttributeNames()) attrPresence[a] = (attrPresence[a] ?? 0) + 1;
  const first = comments[0];
  return {
    version: 1,
    ranAt: new Date().toISOString(),
    page: doc.location?.pathname ?? "",
    commentCount: comments.length,
    attrPresence,
    firstCommentChildren: first
      ? [...first.children].map((ch) => ({
          tag: ch.tagName.toLowerCase(),
          slot: ch.getAttribute("slot"),
          textLength: (ch.textContent ?? "").trim().length,
        }))
      : [],
    treeContainer: Boolean(doc.querySelector("shreddit-comment-tree")),
    loadMoreControls: doc.querySelectorAll("faceplate-partial[src*='more-comments'], [id^='comments-permalink'], shreddit-comment-tree faceplate-partial").length,
    shadowRoot: Boolean(first?.shadowRoot),
    post: postReport(doc),
    fixtures: pickFixtures(comments).map((c) => commentFixture(c, hide)),
  };
}

function postReport(doc: Document): ThreadDiagnostics["post"] {
  const el = doc.querySelector(POST_SELECTOR);
  if (!el) return { present: false, attrs: [], bodyElement: null, textLength: 0 };
  const body = el.querySelector(BODY_SELECTOR) ? BODY_SELECTOR : el.querySelector('[slot="text-body"]') ? '[slot="text-body"]' : null;
  return { present: true, attrs: el.getAttributeNames(), bodyElement: body, textLength: extractPost(el)?.body.length ?? 0 };
}

/** Two top-level comments and one reply when depth is exposed, so nesting shows; else the first three. */
function pickFixtures(comments: Element[]): Element[] {
  if (!comments.some((c) => c.hasAttribute("depth"))) return comments.slice(0, 3);
  const at = (d: string) => comments.filter((c) => c.getAttribute("depth") === d);
  return [...at("0").slice(0, 2), ...at("1").slice(0, 1)];
}
