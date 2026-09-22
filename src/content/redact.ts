// Strips identities from a Reddit card before it leaves the browser as a test
// fixture. Fixtures get committed, so no usernames, account ids, avatars or
// the viewer's timezone may survive. Attribute-level redaction runs on a clone
// of the DOM; a text pass then catches anything embedded in other strings.

const ID_ATTRS = ["author", "author-id", "author-name", "user-id", "current-user-id", "userid", "composer-session-id"];
/** Attributes that hold a user avatar URL on posts and comments. */
const AVATAR_ATTRS = ["icon", "avatar", "author-avatar-url"];
// snoovatars, default avatars, and profile icons (which embed the user's t5_ profile id).
const AVATAR_URL = /https:\/\/[^"'\s)]*\/(?:snoovatar\/avatars|avatars|styles\/profileIcon)[^"'\s)]*/g;

/** Text pass for HTML strings: profile links, u/ mentions, account ids, avatars, extra names. */
export function redactHtml(html: string, extraNames: string[] = []): string {
  let out = html
    .replace(/(\s(?:author|author-id|author-name|user-id|current-user-id|userid)=")[^"]*"/g, '$1REDACTED"')
    .replace(/\/(user|u)\/[A-Za-z0-9_-]+/g, "/$1/REDACTED")
    .replace(/\/user-hover-card\/[A-Za-z0-9_-]+/g, "/user-hover-card/REDACTED")
    .replace(/\bu\/[A-Za-z0-9_-]+/g, "u/REDACTED")
    .replace(/\bt2_[a-z0-9]+/gi, "t2_REDACTED")
    .replace(/(composer_session_id&quot;:&quot;|composer_session_id":")[0-9a-f-]{36}/gi, "$1REDACTED")
    .replace(AVATAR_URL, "https://REDACTED/avatar.png")
    .replace(/(\s(?:alt|aria-label)="[^"]*?)(?:u\/)?[A-Za-z0-9_-]+(?:'s)? avatar"/gi, '$1REDACTED avatar"');
  for (const name of extraNames) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "REDACTED");
  }
  return out;
}

/** Redacts a live card element without touching the page, and returns its HTML. */
export function redactCard(card: Element, extraNames: string[] = []): string {
  const clone = card.cloneNode(true) as Element;
  // Any name that appears as an author (post or comment) is scrubbed everywhere,
  // whatever attribute or text it shows up in.
  const authors = [clone, ...clone.querySelectorAll("[author], [author-name]")]
    .flatMap((el) => [el.getAttribute("author"), el.getAttribute("author-name")])
    .filter((n): n is string => n !== null && n !== "[deleted]" && n.length > 2);
  extraNames = [...new Set([...extraNames, ...authors])];
  for (const el of [clone, ...clone.querySelectorAll("*")]) {
    for (const a of ID_ATTRS) if (el.hasAttribute(a)) el.setAttribute(a, "REDACTED");
    const tag = el.tagName.toLowerCase();
    if (tag === "faceplate-hovercard" && el.hasAttribute("label")) el.setAttribute("label", "REDACTED details");
    if (tag === "faceplate-partial" && /user-hover-card/.test(el.getAttribute("src") ?? ""))
      el.setAttribute("src", "/svc/shreddit/user-hover-card/REDACTED");
    for (const a of AVATAR_ATTRS) if (el.hasAttribute(a)) el.setAttribute(a, "https://REDACTED/avatar.png");
    if (tag === "time") el.removeAttribute("title"); // viewer's local timezone
    if ((tag === "img" || tag === "image") && AVATAR_URL.test(el.getAttribute("src") ?? el.getAttribute("href") ?? "")) {
      el.removeAttribute("src");
      el.removeAttribute("href");
    }
    AVATAR_URL.lastIndex = 0;
  }
  return redactHtml(clone.outerHTML, extraNames);
}
