// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { POST_SELECTOR, cardFor, extractPost, isFeedPath, threadUrl } from "../src/reddit/adapter";
import { fixture } from "./fixture";

const html = fixture("contract-feed.html");

describe("reddit adapter", () => {
  beforeEach(() => {
    document.body.innerHTML = html;
  });

  const posts = () => [...document.querySelectorAll(POST_SELECTOR)];

  it("extracts a text post with body, flair and parsed metadata", () => {
    const p = extractPost(posts()[0]!)!;
    expect(p).toMatchObject({
      id: "abc123",
      title: "How do I trigger an n8n workflow from a Shopify order webhook?",
      body: "Webhook fires but n8n never sees it.\nUsing the cloud version.",
      subreddit: "n8n",
      commentCount: 3,
      flair: "Help",
      author: "someone_else",
    });
    // Reddit's format: six fractional digits and no colon in the offset.
    expect(p.createdAt).toBe(Date.UTC(2026, 8, 21, 18, 4, 11));
  });

  it("strips the t3_ prefix, tolerates a bad timestamp and a missing body", () => {
    const p = extractPost(posts()[1]!)!;
    expect(p.id).toBe("def456");
    expect(p.createdAt).toBeNull();
    expect(p.body).toBe("");
    expect(p.commentCount).toBe(0);
  });

  it("skips posts without a permalink", () => {
    expect(extractPost(posts()[2]!)).toBeNull();
  });

  it("uses the enclosing article as the card, else the post itself", () => {
    expect(cardFor(posts()[0]!).tagName).toBe("ARTICLE");
    expect(cardFor(posts()[2]!).tagName).toBe("SHREDDIT-POST");
  });

  it("treats thread pages as non-feeds", () => {
    expect(isFeedPath("/r/n8n/new/")).toBe(true);
    expect(isFeedPath("/")).toBe(true);
    expect(isFeedPath("/r/n8n/comments/abc123/x/")).toBe(false);
  });

  it("builds absolute thread URLs", () => {
    expect(threadUrl("/r/n8n/comments/abc123/x/", "https://www.reddit.com")).toBe(
      "https://www.reddit.com/r/n8n/comments/abc123/x/",
    );
  });
});
