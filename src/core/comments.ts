// Thread mode, local first pass: which comments on a thread page are worth
// asking Jev about. Pure: no DOM, no chrome APIs.

import type { ThreadComment } from "../reddit/adapter";
import type { Card } from "../shared/types";
import { helpSignal, rankCards } from "./prefilter";

const BOTS = new Set(["automoderator", "[deleted]", "[removed]"]);
export const MAX_CANDIDATES = 40;

export interface CommentCandidate {
  comment: ThreadComment;
  isOp: boolean;
  replyCount: number;
  /** OP asked something and nobody has replied: flagged without Jev. */
  opFollowUp: boolean;
  priority: number;
}

export function selectCandidates(
  comments: ThreadComment[],
  opts: { me: string | null; opAuthor: string; cards: Card[]; weights?: Record<string, number> },
): CommentCandidate[] {
  const me = opts.me?.toLowerCase() ?? null;
  const replies = new Map<string, ThreadComment[]>();
  for (const c of comments) if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c]);

  const out: CommentCandidate[] = [];
  for (const c of comments) {
    const author = c.author.toLowerCase();
    if (c.collapsed || c.moderator || BOTS.has(author) || !c.body) continue;
    if (me && author === me) continue;
    const children = replies.get(c.id) ?? [];
    if (me && children.some((r) => r.author.toLowerCase() === me)) continue; // you already answered it

    const isOp = Boolean(opts.opAuthor) && c.author === opts.opAuthor;
    const help = helpSignal({ title: c.body.split("\n")[0] ?? "", body: c.body, flair: "" }).isLikelyHelp;
    const keywordScore = rankCards({ title: "", body: c.body }, opts.cards, opts.weights).reduce((s, m) => s + m.score, 0);
    if (!help && keywordScore === 0) continue;

    const opFollowUp = isOp && help && children.length === 0;
    const priority = (opFollowUp ? 4 : 0) + (help ? 2 : 0) + Math.min(keywordScore, 3) + (children.length === 0 ? 1 : 0);
    out.push({ comment: c, isOp, replyCount: children.length, opFollowUp, priority });
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, MAX_CANDIDATES);
}

/** Splits candidates into Jev batches; one tier 2 call judges up to `size` comments. */
export function batches<T>(items: T[], size = 15): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
