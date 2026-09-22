import { cardFor } from "../reddit/adapter";
import type { Card, Tier, Tier1Verdict } from "../shared/types";

const BADGE_CLASS = "rjt-badge";
const LABEL: Record<Tier, string> = { strong: "Strong match", good: "Good match", maybe: "Maybe", none: "" };

function badgeFor(post: Element): HTMLButtonElement {
  const prev = post.previousElementSibling;
  if (prev instanceof HTMLButtonElement && prev.classList.contains(BADGE_CLASS)) return prev;
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = BADGE_CLASS;
  // Sibling of the custom element, not a child: unslotted children of a
  // shadow-DOM element may never render. Also keeps clicks off Reddit's
  // full-card link.
  post.before(badge);
  return badge;
}

function removeBadge(post: Element): void {
  const prev = post.previousElementSibling;
  if (prev?.classList.contains(BADGE_CLASS)) prev.remove();
}

export function markPending(post: Element): void {
  cardFor(post).setAttribute("data-rjt-state", "pending");
}

export function clearMark(post: Element): void {
  const card = cardFor(post);
  card.removeAttribute("data-rjt-state");
  card.removeAttribute("data-rjt-tier");
}

export function applyVerdict(
  post: Element,
  tier: Tier,
  verdict: Tier1Verdict,
  ranked: number,
  commentCount: number,
  cards: Card[],
  onOpen: () => void,
): void {
  const card = cardFor(post);
  card.removeAttribute("data-rjt-state");
  card.setAttribute("data-rjt-tier", tier);
  if (tier === "none") {
    removeBadge(post);
    return;
  }
  const badge = badgeFor(post);
  badge.dataset.tier = tier;
  const matched = cards.find((c) => c.id === verdict.bestCard)?.title;
  const unanswered = commentCount === 0 ? " · no replies yet" : "";
  badge.textContent = `${LABEL[tier]} ${Math.round(ranked * 100)}%${matched ? ` · ${matched}` : ""}${unanswered} ▸`;
  badge.title = `Preview before opening. Help request ${Math.round(verdict.helpProb * 100)}%, match confidence ${Math.round(
    verdict.matchConfidence * 100,
  )}%`;
  badge.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onOpen();
  };
}

/** Threads you already commented in, or your own posts: dimmed, never scored. */
export function applyReplied(post: Element, label: string): void {
  const card = cardFor(post);
  card.removeAttribute("data-rjt-state");
  card.setAttribute("data-rjt-tier", "replied");
  const badge = badgeFor(post);
  badge.dataset.tier = "replied";
  badge.textContent = label;
  badge.title = "";
  badge.onclick = null;
  badge.disabled = true;
}

export function dismiss(post: Element): void {
  cardFor(post).setAttribute("data-rjt-tier", "dismissed");
  removeBadge(post);
}

const noticesShown = new Set<string>(); // once per message, so a new problem is never hidden by an old one
export function showNotice(message: string): void {
  if (noticesShown.has(message)) return;
  noticesShown.add(message);
  const n = document.createElement("div");
  n.className = "rjt-notice";
  n.textContent = `Reddit Jev Tool: ${message}`;
  n.addEventListener("click", () => n.remove());
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 12_000);
}
