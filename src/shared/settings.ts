import type { Card, Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "jev-1.13.0",
  subredditMode: "all",
  subreddits: [],
  threshold: 0.6,
  maxComments: 40,
  scoreWithoutKeywords: false,
  dailyCallCap: 500,
  unansweredBoost: 0.1,
  scanThreads: true,
  enabled: true,
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = (await chrome.storage.local.get("settings")) as { settings?: Partial<Settings> };
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function loadCards(): Promise<Card[]> {
  const { cards } = (await chrome.storage.local.get("cards")) as { cards?: Card[] };
  return cards ?? [];
}

export async function saveCards(cards: Card[]): Promise<void> {
  await chrome.storage.local.set({ cards });
}

export const normalizeSub = (s: string): string => s.trim().replace(/^\/?r\//i, "").toLowerCase();
