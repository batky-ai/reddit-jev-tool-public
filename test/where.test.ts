import { describe, expect, it } from "vitest";
import { whereToComment } from "../src/content/preview";

const c = (id: string, o: Partial<{ isOp: boolean; replyCount: number; body: string }> = {}) => ({
  id, author: "a", body: o.body ?? `comment ${id}`, score: 1, isOp: o.isOp ?? false, replyCount: o.replyCount ?? 1, permalink: `/c/${id}/`,
});

// Scores below are taken from the live replay of six r/n8n threads on 2026-09-22.
describe("whereToComment", () => {
  it("prefers an unanswered OP follow-up over any Jev score", () => {
    const op = c("op", { isOp: true, replyCount: 0, body: "Nice. How would you define normal output for that check?" });
    const r = whereToComment([c("x"), op], { valueProbs: { x: 0.9, op: 0.76 }, answeredProb: 0.33 });
    expect(r.kind).toBe("op-followup");
    expect(r.targets.map((t) => t.id)).toEqual(["op"]);
  });

  it("lists every comment at or above 0.8, strongest first", () => {
    const r = whereToComment([c("a"), c("b"), c("d")], { valueProbs: { a: 0.82, b: 0.9, d: 0.2 }, answeredProb: 0.1 });
    expect(r.kind).toBe("comment");
    expect(r.targets.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("falls back to the best comment in the 0.6-0.8 band (real threads live here)", () => {
    const r = whereToComment([c("rubric"), c("noise")], { valueProbs: { rubric: 0.67, noise: 0.06 }, answeredProb: 0.33 });
    expect(r).toMatchObject({ kind: "maybe", targets: [expect.objectContaining({ id: "rubric" })] });
    expect(r.text).toContain("67%");
  });

  it("says reply to the post when no comment leaves a gap and the post is open", () => {
    const r = whereToComment([c("a")], { valueProbs: { a: 0.54 }, answeredProb: 0.2 });
    expect(r).toMatchObject({ kind: "post", targets: [] });
    expect(r.text).toContain("highest 54%");
  });

  it("says probably skip when the post already looks answered", () => {
    expect(whereToComment([c("a")], { valueProbs: { a: 0.3 }, answeredProb: 0.8 }).kind).toBe("answered");
  });

  it("handles no comments and a failed Jev call", () => {
    expect(whereToComment([], null).kind).toBe("post");
    expect(whereToComment([c("a")], null).kind).toBe("unknown");
  });
});

describe("whereToComment when OP is done", () => {
  it("says the original poster no longer needs help when Jev scores that low", () => {
    const r = whereToComment([c("a")], { valueProbs: { a: 0.58 }, answeredProb: 0.38, stillNeedsProb: 0.06 });
    expect(r.kind).toBe("answered");
    expect(r.text).toContain("doesn't seem to need help anymore");
  });
});
