// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { runThreadDiagnostics } from "../src/content/thread-spike";

const THREAD = `
<shreddit-comment-tree>
  <shreddit-comment thingid="t1_a1" author="First_Person" depth="0" score="5" permalink="/r/x/comments/p1/t/a1/">
    <div slot="comment"><p>Top-level answer.</p></div>
    <shreddit-comment thingid="t1_b1" author="Second_Person" depth="1" score="2" permalink="/r/x/comments/p1/t/b1/">
      <div slot="comment"><p>Follow-up from Second_Person?</p></div>
    </shreddit-comment>
  </shreddit-comment>
  <shreddit-comment thingid="t1_a2" author="Viewer_Me" depth="0" score="1">
    <div slot="comment"><p>My own reply.</p></div>
  </shreddit-comment>
</shreddit-comment-tree>`;

describe("runThreadDiagnostics", () => {
  document.body.innerHTML = THREAD;
  const r = runThreadDiagnostics(document, ["Viewer_Me"]);

  it("reports comment attributes, body location and tree container", () => {
    expect(r.commentCount).toBe(3);
    expect(r.attrPresence).toMatchObject({ thingid: 3, author: 3, depth: 3, permalink: 2 });
    expect(r.firstCommentChildren[0]).toEqual({ tag: "div", slot: "comment", textLength: 17 });
    expect(r.treeContainer).toBe(true);
    expect(r.post).toEqual({ present: false, attrs: [], bodyElement: null, textLength: 0 });
  });

  it("keeps two top-level comments and one reply, without nested replies, and no usernames", () => {
    expect(r.fixtures).toHaveLength(3);
    expect(r.fixtures[0]).not.toContain("t1_b1"); // nested reply stripped from its parent
    const all = r.fixtures.join("\n");
    expect(all).not.toMatch(/First_Person|Second_Person|Viewer_Me/);
    expect(all).toContain("Follow-up from REDACTED?");
  });
});
