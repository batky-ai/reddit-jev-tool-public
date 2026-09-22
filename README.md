# reddit-jev-tool

Chrome MV3 extension that highlights Reddit feed posts you can answer, scored by TypeSafe Jev against your own expertise cards and tuned by your feedback.

## What this is

A browser extension for people who want to help on Reddit without trawling
every feed. As you scroll, it reads each post card your browser has already
rendered, filters for help requests locally, and asks TypeSafe's Jev model how
well the post matches your expertise cards. Good matches get a highlight.
Opening a highlight shows the post text and top comments, with chips such as
"already well answered", before you click into the thread. Your feedback
(answered, skip, not my area) tunes the threshold and keyword weights.

It works on any subreddit or feed you can see, because it reads your own
rendered page and needs no Reddit API approval. It never posts, votes or
comments.

**Status:** v0.2. Highlighting, preview with comments, "you already replied"
dimming, feedback and learning are built. Not yet exercised on a live feed.

## Stack

- TypeScript, esbuild, Chrome Manifest V3. No backend.
- vitest + jsdom for tests.
- TypeSafe Jev (`POST https://api.typesafe.ai/v1/systemone`, pinned
  `jev-1.13.0`), called from the service worker with the user's own key.
- Foundation: nothing adopted. `dephelion/ufeed` (GPL-3.0) and
  `might-as-well/reddit-ai-blocker` (no license) were reviewed for the Reddit
  feed DOM contract only. No code was copied. API pollers such as
  `Askir/reddit-llm-alerts` depend on Reddit's closed self-serve API.

## Setup

```bash
cd ~/projects/reddit-jev-tool
npm install
npm run build
```

Then in Chrome open `chrome://extensions`, turn on Developer mode, click
**Load unpacked** and pick the `dist/` folder. After each rebuild, click the
reload icon on the extension card, then reload any open Reddit tabs: the old
content script loses its connection to the service worker.

## Environment

The extension has no `.env`. The TypeSafe key is pasted into the options page
by each user and stored in `chrome.storage.local`. Local smoke tests read the
developer key from `~/.config/api-keys/typesafe-emb` directly.

## Usage

1. Click the extension icon to open the options page. Paste your TypeSafe key,
   then paste your expertise cards (see `seed-packs/` for the format) and click
   **Save cards**.
2. Log in to reddit.com and scroll any feed. Help requests that match your
   cards get a green or amber edge and a badge. Threads you already commented
   in, and your own posts, are dimmed.
3. Click a badge to open the preview: the full post, its top comments, and
   chips for "Already answered" and "OP still needs help". Then **Open thread**,
   **I answered**, **Skip** or **Not my area**.
4. On a thread page, comments where you could add value get a badge: an
   unanswered follow-up question from the original poster (no Jev needed), or
   Jev's pick of the best comment to reply to. Clicking a badge opens Reddit's
   own reply box for that comment; the pill at the bottom right jumps between
   them. This reads the comments already on the page and makes no Reddit
   requests; it uses up to 3 Jev calls per thread and can be turned off in
   the options.
5. Your clicks train it. The Learning section on the options page shows what
   changed, exports the feedback log, and resets it.

Check how well scores predict what you answer:

```bash
node scripts/eval-feedback.mjs ~/Downloads/reddit-jev-feedback-YYYY-MM-DD.json
```

Diagnostics: on a feed page opened directly, **Run Jev diagnostics** (bottom
right, shown until a report exists) checks the page structure and Reddit
access, and stores a redacted report in the options page.

```bash
npm run check   # typecheck, tests, build
npm run watch   # rebuild on change
```

## Privacy

Only public Reddit post and comment text and your own expertise cards are
sent to TypeSafe; usernames are not. Your key, cards and feedback stay in your
browser. Reddit requests run from your logged-in session: your identity and
recent comments (at most once per 30 minutes, to dim threads you answered) and
one thread per preview you open. They are cached, at least 2 seconds apart, and
pause when Reddit's rate-limit budget runs low. That is automated access to
Reddit from your account, which is a grey area in Reddit's terms, so the
extension keeps it rare.
