// Storage for the feedback log and the model learned from it. Both live in
// chrome.storage.local, so they stay in this browser.

import { EMPTY_LEARNED, appendEvent, learn, type FeedbackEvent, type Learned } from "../core/learning";
import { loadSettings } from "./settings";

export async function loadFeedback(): Promise<FeedbackEvent[]> {
  const { feedback } = (await chrome.storage.local.get("feedback")) as { feedback?: FeedbackEvent[] };
  return feedback ?? [];
}

export async function loadLearned(): Promise<Learned> {
  const { learned } = (await chrome.storage.local.get("learned")) as { learned?: Learned };
  return { ...EMPTY_LEARNED, ...learned };
}

// Serialized so two quick clicks cannot overwrite each other's append.
let chain: Promise<unknown> = Promise.resolve();

export function recordFeedback(event: FeedbackEvent): Promise<Learned> {
  const run = chain.then(async () => {
    const [events, settings] = await Promise.all([loadFeedback(), loadSettings()]);
    const next = appendEvent(events, event);
    const learned = learn(next, settings.threshold, Date.now());
    await chrome.storage.local.set({ feedback: next, learned });
    return learned;
  });
  chain = run.catch(() => undefined);
  return run;
}

export async function resetLearning(): Promise<void> {
  await chrome.storage.local.remove(["feedback", "learned"]);
}
