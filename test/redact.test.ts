// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { redactCard, redactHtml } from "../src/content/redact";
import { fixture } from "./fixture";

// Every identity-bearing pattern seen in the live feed, with invented names.
const LEAKY_CARD = `
<article data-post-id="t3_aaa111">
  <shreddit-post id="t3_aaa111" user-id="t2_viewer9zz" author-id="t2_poster7qq" author="Fake_Poster_42"
    icon="https://preview.redd.it/snoovatar/avatars/1234abcd-headshot.png?width=64" permalink="/r/x/comments/aaa111/t/">
    <faceplate-hovercard label="Fake_Poster_42 details">
      <a aria-label="Author: u/Fake_Poster_42" href="https://www.reddit.com/user/Fake_Poster_42/">
        <image href="https://preview.redd.it/snoovatar/avatars/1234abcd-headshot.png" alt="Fake_Poster_42 avatar"></image>
        <span class="truncate">u/Fake_Poster_42</span>
      </a>
      <faceplate-partial src="/svc/shreddit/user-hover-card/Fake_Poster_42?subredditName=x"></faceplate-partial>
    </faceplate-hovercard>
    <author-flair-event-handler userid="t2_poster7qq"></author-flair-event-handler>
    <time datetime="2026-09-21T20:58:32.673Z" title="Monday, September 21, 2026 at 1:58:32 PM PDT">2 hr. ago</time>
    <shreddit-post-overflow-menu author-name="Fake_Poster_42" current-user-id="t2_viewer9zz"
      data-faceplate-tracking-context="{&quot;user&quot;:&quot;t2_viewer9zz&quot;}"></shreddit-post-overflow-menu>
    <shreddit-post-text-body><p>Mentions u/Another_Person and Viewer_Name_X in the text.</p></shreddit-post-text-body>
  </shreddit-post>
</article>`;

describe("redactCard", () => {
  const html = (() => {
    document.body.innerHTML = LEAKY_CARD;
    return redactCard(document.querySelector("article")!, ["Viewer_Name_X"]);
  })();

  it.each([
    "Fake_Poster_42",
    "Another_Person",
    "Viewer_Name_X",
    "t2_viewer9zz",
    "t2_poster7qq",
    "snoovatar/avatars",
    "1234abcd",
    "PDT",
  ])("removes %s", (secret) => {
    expect(html).not.toContain(secret);
  });

  it("keeps post structure and content", () => {
    expect(html).toContain('permalink="/r/x/comments/aaa111/t/"');
    expect(html).toContain('datetime="2026-09-21T20:58:32.673Z"');
    expect(html).toContain("Mentions u/REDACTED");
  });

  it("does not modify the live page", () => {
    expect(document.querySelector("shreddit-post")!.getAttribute("author")).toBe("Fake_Poster_42");
  });
});

describe("redactHtml", () => {
  const html = fixture("contract-feed.html");

  it("removes usernames from the contract fixture", () => {
    expect(redactHtml(html)).not.toMatch(/someone_else|builder_1/);
  });

  it("leaves post content alone", () => {
    expect(redactHtml(html)).toContain("Webhook fires but");
  });
});

describe("redactCard on comments", () => {
  it("scrubs a comment author wherever the name appears", () => {
    document.body.innerHTML = `
      <shreddit-comment author="Comment_Writer_9" thingid="t1_abc" permalink="/r/x/comments/p1/t/abc/">
        <div slot="comment"><p>As Comment_Writer_9 said before, try this.</p></div>
        <span data-owner="Comment_Writer_9"></span>
      </shreddit-comment>`;
    const html = redactCard(document.querySelector("shreddit-comment")!);
    expect(html).not.toContain("Comment_Writer_9");
    expect(html).toContain('thingid="t1_abc"');
    expect(html).toContain("try this");
  });
});

describe("redactCard on live comment shapes", () => {
  it("removes profile-icon avatars, avatar attributes and composer session ids", () => {
    document.body.innerHTML = `
      <shreddit-comment author="Bot_Account_1" avatar="https://styles.redditmedia.com/t5_1abcde/styles/profileIcon_xyz.png?width=64" thingid="t1_c1">
        <img src="https://styles.redditmedia.com/t5_1abcde/styles/profileIcon_xyz.png?width=64" alt="Bot_Account_1 avatar">
        <shreddit-comment-action-row author-avatar-url="https://preview.redd.it/snoovatar/avatars/aa.png" author-name="Bot_Account_1"></shreddit-comment-action-row>
        <comment-composer-host composer-session-id="30e65a96-f9f6-4bcc-8e5c-1c2581774c91"></comment-composer-host>
        <faceplate-tracker data-faceplate-tracking-context='{"automoderator":{"composer_session_id":"30e65a96-f9f6-4bcc-8e5c-1c2581774c91"}}'></faceplate-tracker>
      </shreddit-comment>`;
    const html = redactCard(document.querySelector("shreddit-comment")!);
    for (const secret of ["Bot_Account_1", "t5_1abcde", "profileIcon", "snoovatar", "30e65a96"]) expect(html).not.toContain(secret);
    expect(html).toContain('thingid="t1_c1"');
  });
});
