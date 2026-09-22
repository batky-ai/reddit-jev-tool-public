// Service worker. Jev calls live here so the key never touches page context.
import { loadSettings } from "../shared/settings";
import type { AssessRequestMessage, ScoreRequestMessage } from "../shared/types";
import { createScorer, defaultJev, type KV } from "./scorer";

const area = (store: chrome.storage.StorageArea): KV => ({
  async get(key) {
    return (await store.get(key))[key];
  },
  async set(key, value) {
    await store.set({ [key]: value });
  },
});

const scorer = createScorer({
  cache: area(chrome.storage.session),
  counters: area(chrome.storage.local),
  loadSettings,
  jev: defaultJev,
  now: () => Date.now(),
});

type Message = ScoreRequestMessage | AssessRequestMessage;

chrome.runtime.onMessage.addListener((msg: Message, _sender, reply: (r: unknown) => void) => {
  const work =
    msg?.type === "score" ? scorer.score(msg.post, msg.cards) : msg?.type === "assess" ? scorer.assess(msg.post, msg.comments, msg.cards ?? []) : null;
  if (!work) return false;
  work.then(reply, (e) => reply({ ok: false, error: String(e), retryable: true }));
  return true; // async reply
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
