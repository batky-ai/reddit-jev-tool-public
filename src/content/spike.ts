// Task 1 spike: answers "can a content script read a thread's comments and the
// user's own comments from the logged-in session, and does the feed DOM match
// the adapter contract?" It runs once, on a button click, with a 2 second gap
// between requests and stops at the first 429. The report is stored locally and
// shown on the options page for the user to copy back.

import {
  COMMENT_SELECTOR,
  POST_ATTRS,
  POST_SELECTOR,
  BODY_SELECTOR,
  cardFor,
  extractPost,
  threadUrl,
} from "../reddit/adapter";
import { redactCard } from "./redact";

export interface ProbeResult {
  name: string;
  path: string;
  status: number | null;
  contentType: string;
  bytes: number;
  ms: number;
  rateLimit: Record<string, string>;
  finalPath: string;
  found: number | null;
  note: string;
}

export interface DiagnosticsReport {
  version: 1;
  ranAt: string;
  page: string;
  userAgent: string;
  dom: {
    postCount: number;
    attrPresence: Record<string, number>;
    bodyInPost: number;
    bodyInCard: number;
    articleCards: number;
    samplePosts: Array<{ id: string; subreddit: string; commentCount: number; hasBody: boolean; titleLength: number }>;
  };
  identity: { found: boolean; via: string };
  probes: ProbeResult[];
  stoppedEarly: string | null;
  fixtures: string[];
}

const GAP_MS = 2000;
const FIXTURE_CAP = 40_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function domReport(doc: Document): DiagnosticsReport["dom"] {
  const posts = [...doc.querySelectorAll(POST_SELECTOR)];
  const attrPresence: Record<string, number> = {};
  for (const a of POST_ATTRS) attrPresence[a] = posts.filter((p) => p.hasAttribute(a)).length;
  return {
    postCount: posts.length,
    attrPresence,
    bodyInPost: posts.filter((p) => p.querySelector(BODY_SELECTOR)).length,
    bodyInCard: posts.filter((p) => cardFor(p).querySelector(BODY_SELECTOR)).length,
    articleCards: posts.filter((p) => p.closest("article")).length,
    samplePosts: posts.slice(0, 10).flatMap((p) => {
      const f = extractPost(p);
      return f
        ? [{ id: f.id, subreddit: f.subreddit, commentCount: f.commentCount, hasBody: f.body.length > 0, titleLength: f.title.length }]
        : [];
    }),
  };
}

type Counter = (body: string) => number | null;

const countJsonComments: Counter = (body) => {
  const data = JSON.parse(body);
  if (Array.isArray(data)) return data[1]?.data?.children?.length ?? 0;
  return data?.data?.children?.length ?? null;
};
const countHtml =
  (selector: string): Counter =>
  (body) =>
    new DOMParser().parseFromString(body, "text/html").querySelectorAll(selector).length;
const countRssEntries: Counter = (body) =>
  new DOMParser().parseFromString(body, "application/xml").getElementsByTagName("entry").length;

async function probe(name: string, url: string, count: Counter, hide: string[]): Promise<ProbeResult> {
  const mask = (s: string) => hide.reduce((acc, h) => (h ? acc.split(h).join("ME") : acc), s);
  const started = performance.now();
  const result: ProbeResult = {
    name,
    path: mask(new URL(url).pathname + new URL(url).search),
    status: null,
    contentType: "",
    bytes: 0,
    ms: 0,
    rateLimit: {},
    finalPath: "",
    found: null,
    note: "",
  };
  try {
    const res = await fetch(url, { credentials: "include", headers: { Accept: "*/*" } });
    const body = await res.text();
    result.status = res.status;
    result.contentType = res.headers.get("content-type") ?? "";
    result.bytes = body.length;
    result.finalPath = mask(new URL(res.url).pathname);
    for (const h of ["x-ratelimit-used", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
      const v = res.headers.get(h);
      if (v !== null) result.rateLimit[h] = v;
    }
    if (res.ok) {
      try {
        result.found = count(body);
      } catch (e) {
        result.note = `parse failed: ${(e as Error).message}`.slice(0, 200);
      }
    }
  } catch (e) {
    result.note = `fetch failed: ${(e as Error).message}`.slice(0, 200);
  }
  result.ms = Math.round(performance.now() - started);
  return result;
}

async function identity(): Promise<{ name: string; via: string }> {
  try {
    const res = await fetch("/api/me.json", { credentials: "include" });
    if (res.ok) {
      const d = await res.json();
      const name = d?.data?.name ?? d?.name;
      if (typeof name === "string" && name) return { name, via: "api/me.json" };
    }
  } catch {
    /* fall through to DOM lookup */
  }
  const attr = document.querySelector("shreddit-app")?.getAttribute("user-name");
  if (attr) return { name: attr, via: "shreddit-app[user-name]" };
  return { name: "", via: "none" };
}

export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const dom = domReport(document);
  const me = await identity();
  const hide = me.name ? [me.name] : [];
  const report: DiagnosticsReport = {
    version: 1,
    ranAt: new Date().toISOString(),
    page: location.pathname,
    userAgent: navigator.userAgent,
    dom,
    identity: { found: Boolean(me.name), via: me.via },
    probes: [],
    stoppedEarly: null,
    fixtures: [...document.querySelectorAll(POST_SELECTOR)]
      .slice(0, 3)
      .map((p) => redactCard(cardFor(p), hide).slice(0, FIXTURE_CAP)),
  };

  const posts = [...document.querySelectorAll(POST_SELECTOR)].map(extractPost).filter((p) => p !== null);
  const target = posts.find((p) => p.commentCount > 0) ?? posts[0];

  const plan: Array<[string, string, Counter]> = [];
  if (target) {
    const url = threadUrl(target.permalink).replace(/\/?$/, "/");
    plan.push(
      ["thread.json", `${url}.json?raw_json=1&limit=20`, countJsonComments],
      ["thread.html", url, countHtml(COMMENT_SELECTOR)],
      ["thread.rss", `${url}.rss?limit=20`, countRssEntries],
      [
        "thread.svc-partial",
        `${location.origin}/svc/shreddit/comments/r/${target.subreddit}/t3_${target.id}?render-mode=partial`,
        countHtml(COMMENT_SELECTOR),
      ],
    );
  }
  if (me.name) {
    const u = `${location.origin}/user/${encodeURIComponent(me.name)}/comments/`;
    plan.push(
      ["user.json", `${u}.json?raw_json=1&limit=25`, countJsonComments],
      ["user.html", u, countHtml(`${COMMENT_SELECTOR}, shreddit-profile-comment`)],
      ["user.rss", `${u}.rss?limit=25`, countRssEntries],
    );
  }

  for (const [i, [name, url, count]] of plan.entries()) {
    if (i > 0) await sleep(GAP_MS);
    const r = await probe(name, url, count, hide);
    report.probes.push(r);
    if (r.status === 429) {
      report.stoppedEarly = `429 on ${name}; remaining probes skipped`;
      break;
    }
  }
  return report;
}
