// Expertise cards as plain markdown, so users can write and share them easily:
//
//   ## n8n cloud workflows
//   keywords: n8n, webhook, workflow
//   Builds and debugs n8n cloud workflows ...
//
// A JSON array of {title, summary, keywords} is accepted too.

import type { Card } from "../shared/types";

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "card";

function uniqueIds(cards: Omit<Card, "id">[]): Card[] {
  const used = new Map<string, number>();
  return cards.map((c) => {
    const base = slug(c.title);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return { ...c, id: n === 0 ? base : `${base}-${n + 1}` };
  });
}

const splitKeywords = (s: string) =>
  [...new Set(s.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean))];

export function parseCards(input: string): Card[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const raw = JSON.parse(trimmed) as Array<Partial<Card>>;
    return uniqueIds(
      raw
        .filter((c) => typeof c.title === "string" && c.title.trim())
        .map((c) => ({
          title: c.title!.trim(),
          summary: (c.summary ?? "").trim(),
          keywords: splitKeywords((c.keywords ?? []).join(",")),
        })),
    );
  }
  const cards: Omit<Card, "id">[] = [];
  for (const block of trimmed.split(/^##\s+/m).slice(1)) {
    const [titleLine = "", ...rest] = block.split("\n");
    const title = titleLine.trim();
    if (!title) continue;
    let keywords: string[] = [];
    const summary: string[] = [];
    for (const line of rest) {
      const m = line.match(/^\s*keywords\s*:\s*(.*)$/i);
      if (m) keywords = splitKeywords(m[1] ?? "");
      else summary.push(line);
    }
    cards.push({ title, keywords, summary: summary.join("\n").trim() });
  }
  return uniqueIds(cards);
}

export function formatCards(cards: Card[]): string {
  return cards
    .map((c) => `## ${c.title}\nkeywords: ${c.keywords.join(", ")}\n${c.summary}`.trim())
    .join("\n\n");
}
