import { describe, expect, it } from "vitest";
import { formatCards, parseCards } from "../src/core/cards";

const md = `
## n8n cloud workflows
keywords: n8n, Webhook, workflow, n8n
Builds and debugs n8n cloud workflows.
Knows test vs production webhook URLs.

## Shopify themes
Keywords:liquid, theme
Liquid sections and theme files.

## Shopify themes
keywords: dawn
`;

describe("cards", () => {
  it("parses markdown blocks with deduped lowercase keywords and unique ids", () => {
    const cards = parseCards(md);
    expect(cards.map((c) => c.id)).toEqual(["n8n-cloud-workflows", "shopify-themes", "shopify-themes-2"]);
    expect(cards[0]!.keywords).toEqual(["n8n", "webhook", "workflow"]);
    expect(cards[0]!.summary).toBe("Builds and debugs n8n cloud workflows.\nKnows test vs production webhook URLs.");
    expect(cards[1]!.keywords).toEqual(["liquid", "theme"]);
  });

  it("round-trips through formatCards", () => {
    const cards = parseCards(md);
    expect(parseCards(formatCards(cards))).toEqual(cards);
  });

  it("accepts a JSON array and skips entries without a title", () => {
    const cards = parseCards(JSON.stringify([{ title: "Railway", summary: "Deploys", keywords: ["Railway"] }, { summary: "x" }]));
    expect(cards).toEqual([{ id: "railway", title: "Railway", summary: "Deploys", keywords: ["railway"] }]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCards("   ")).toEqual([]);
  });
});
