import { isFeedPath } from "../reddit/adapter";
import { createRedditClient } from "../reddit/client";
import { rescanFeed, startFeed } from "./feed";
import { startThread } from "./thread";
import { runDiagnostics } from "./spike";
import { runThreadDiagnostics } from "./thread-spike";

const BUTTON_ID = "rjt-diagnostics-button";

/**
 * One diagnostics button per page kind, shown until that kind has a report:
 * feed pages probe Reddit access, thread pages record the comment DOM.
 */
async function mountDiagnosticsButton(): Promise<void> {
  const feed = isFeedPath(location.pathname);
  const existing = document.getElementById(BUTTON_ID);
  if (existing?.dataset.kind === (feed ? "feed" : "thread")) return;
  existing?.remove(); // page kind changed through in-app navigation
  const key = feed ? "diagnostics" : "threadDiagnostics";
  if ((await chrome.storage.local.get(key))[key]) return; // already ran; rerun from the options page

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.dataset.kind = feed ? "feed" : "thread";
  btn.textContent = feed ? "Run Jev diagnostics" : "Run Jev thread diagnostics";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Running...";
    try {
      const { me } = (await chrome.storage.local.get("me")) as { me?: { name: string } };
      const report = feed ? await runDiagnostics() : runThreadDiagnostics(document, me?.name ? [me.name] : []);
      await chrome.storage.local.set({ [key]: report });
      btn.textContent = "Done. Open the extension options to copy the report.";
    } catch (e) {
      btn.textContent = `Diagnostics failed: ${(e as Error).message}`;
    }
  });
  document.body.appendChild(btn);
}

const client = createRedditClient({
  fetch: (u, i) => fetch(u, i),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  origin: location.origin,
  store: {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: async (key, value) => chrome.storage.local.set({ [key]: value }),
  },
});

void mountDiagnosticsButton();
// Both modes watch the page for the whole session and act only on their page
// kind, because Reddit moves between feeds and threads without a page load.
void startFeed(client);
void startThread(client);

// Reddit navigates between feed and thread pages without a page load, so the
// content script only runs once. Re-check the page kind when the path changes.
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  void mountDiagnosticsButton();
  rescanFeed();
}, 1000);
