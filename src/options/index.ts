import type { DiagnosticsReport } from "../content/spike";
import type { ThreadDiagnostics } from "../content/thread-spike";
import { formatCards, parseCards } from "../core/cards";
import { loadFeedback, loadLearned, resetLearning } from "../shared/feedback";
import { loadCards, loadSettings, normalizeSub, saveCards, saveSettings } from "../shared/settings";
import type { Settings, SubredditMode } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const saveStatus = $("save-status");

function flash(el: HTMLElement, text: string): void {
  el.textContent = text;
  setTimeout(() => {
    if (el.textContent === text) el.textContent = "";
  }, 2500);
}

// ---- settings ----
const numberFields = ["threshold", "maxComments", "dailyCallCap", "unansweredBoost"] as const;

async function renderSettings(): Promise<void> {
  const s = await loadSettings();
  $<HTMLInputElement>("apiKey").value = s.apiKey;
  $<HTMLInputElement>("enabled").checked = s.enabled;
  $<HTMLInputElement>("scoreWithoutKeywords").checked = s.scoreWithoutKeywords;
  $<HTMLInputElement>("scanThreads").checked = s.scanThreads;
  $<HTMLTextAreaElement>("subreddits").value = s.subreddits.join(", ");
  for (const f of numberFields) $<HTMLInputElement>(f).value = String(s[f]);
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=subredditMode]")) r.checked = r.value === s.subredditMode;

  const { jevCalls } = (await chrome.storage.local.get("jevCalls")) as { jevCalls?: { day: string; count: number } };
  const today = new Date().toISOString().slice(0, 10);
  $("usage").textContent = `Jev calls today (UTC): ${jevCalls?.day === today ? jevCalls.count : 0} of ${s.dailyCallCap}`;
}

async function persistSettings(): Promise<void> {
  const patch: Partial<Settings> = {
    apiKey: $<HTMLInputElement>("apiKey").value.trim(),
    enabled: $<HTMLInputElement>("enabled").checked,
    scoreWithoutKeywords: $<HTMLInputElement>("scoreWithoutKeywords").checked,
    scanThreads: $<HTMLInputElement>("scanThreads").checked,
    subreddits: $<HTMLTextAreaElement>("subreddits").value.split(/[\s,]+/).map(normalizeSub).filter(Boolean),
    subredditMode:
      (document.querySelector<HTMLInputElement>("input[name=subredditMode]:checked")?.value as SubredditMode) ?? "all",
  };
  for (const f of numberFields) {
    const v = Number($<HTMLInputElement>(f).value);
    if (Number.isFinite(v) && v >= 0) patch[f] = f === "threshold" || f === "unansweredBoost" ? Math.min(1, v) : v;
  }
  await saveSettings(patch);
  flash(saveStatus, "Saved.");
}

for (const el of document.querySelectorAll("section input, #subreddits")) el.addEventListener("change", () => void persistSettings());

// ---- cards ----
async function renderCards(): Promise<void> {
  $<HTMLTextAreaElement>("cards").value = formatCards(await loadCards());
}

$("cards-save").addEventListener("click", async () => {
  const status = $("cards-status");
  try {
    const cards = parseCards($<HTMLTextAreaElement>("cards").value);
    const bare = cards.filter((c) => c.keywords.length === 0).map((c) => c.title);
    await saveCards(cards);
    await renderCards();
    status.textContent =
      `Saved ${cards.length} card${cards.length === 1 ? "" : "s"}.` +
      (bare.length ? ` No keywords on: ${bare.join(", ")}. Those only match with "score without keywords" on.` : "");
  } catch (e) {
    status.textContent = `Could not read cards: ${(e as Error).message}`;
  }
});

// ---- learning ----
async function renderLearning(): Promise<void> {
  const [learned, events, s] = await Promise.all([loadLearned(), loadFeedback(), loadSettings()]);
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
  const changed = Object.entries(learned.keywordWeights)
    .filter(([, w]) => Math.abs(w - 1) > 1e-9)
    .sort((a, b) => b[1] - a[1]);
  const lines = [
    `Labelled posts: ${learned.labelled} (${[...counts].map(([a, n]) => `${a} ${n}`).join(", ") || "no feedback yet"})`,
    `Threshold: base ${s.threshold.toFixed(2)} ${learned.thresholdDelta >= 0 ? "+" : "-"} learned ${Math.abs(learned.thresholdDelta).toFixed(2)}` +
      (learned.labelled < 8 ? "  (needs 8 labelled posts with both answers and skips before it moves)" : ""),
    `Subreddit offsets: ${Object.entries(learned.subredditOffsets).map(([k, v]) => `r/${k} ${v > 0 ? "+" : ""}${v}`).join(", ") || "none yet"}`,
    `Keyword weights (1 = default): ${changed.map(([k, w]) => `${k.split("::")[1]} ${w.toFixed(2)}`).join(", ") || "none changed yet"}`,
  ];
  $("learning-summary").textContent = lines.join("\n");
}

$("feedback-export").addEventListener("click", async () => {
  const events = await loadFeedback();
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `reddit-jev-feedback-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("learning-reset").addEventListener("click", async () => {
  if (!confirm("Delete all feedback and learned adjustments? Your cards and settings stay.")) return;
  await resetLearning();
  await renderLearning();
  flash($("learning-status"), "Learning reset.");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.learned || changes.feedback)) void renderLearning();
});

// ---- diagnostics ----
const out = $<HTMLTextAreaElement>("diagnostics-output");
const diagStatus = $("diagnostics-status");

async function renderDiagnostics(): Promise<void> {
  const { diagnostics } = (await chrome.storage.local.get("diagnostics")) as { diagnostics?: DiagnosticsReport };
  const { threadDiagnostics } = (await chrome.storage.local.get("threadDiagnostics")) as { threadDiagnostics?: ThreadDiagnostics };
  if (!diagnostics && !threadDiagnostics) {
    out.value = "";
    diagStatus.textContent =
      "No report yet. Open a Reddit feed or thread page directly while logged in and click the diagnostics button at the bottom right.";
    return;
  }
  // Thread report first: it is the newer one and the one currently needed.
  out.value = JSON.stringify({ thread: threadDiagnostics ?? null, feed: diagnostics ?? null }, null, 2);
  diagStatus.textContent =
    `Feed report: ${diagnostics?.ranAt ?? "none"}. Thread report: ${threadDiagnostics?.ranAt ?? "none (open a thread page directly and click the button)"}.` +
    " Copy it and paste it back to Claude.";
}

$("diagnostics-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(out.value);
  flash(diagStatus, "Copied.");
});

$("diagnostics-reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(["diagnostics", "threadDiagnostics"]);
  await renderDiagnostics();
});

void renderSettings();
void renderCards();
void renderLearning();
void renderDiagnostics();
