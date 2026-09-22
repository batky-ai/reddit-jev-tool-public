import { describe, expect, it } from "vitest";
import {
  EMPTY_LEARNED,
  MAX_EVENTS,
  answeredIds,
  appendEvent,
  effectiveThreshold,
  keywordWeights,
  latestLabels,
  learn,
  refitThreshold,
  subredditOffsets,
  type FeedbackAction,
  type FeedbackEvent,
} from "../src/core/learning";

let t = 0;
const ev = (postId: string, action: FeedbackAction, match: number | null = 0.6, o: Partial<FeedbackEvent> = {}): FeedbackEvent => ({
  postId,
  subreddit: "n8n",
  action,
  at: ++t,
  match,
  helpProb: 0.9,
  bestCard: "n8n",
  hits: ["n8n::n8n"],
  ...o,
});

describe("latestLabels", () => {
  it("keeps the latest label per post and ignores opened/previewed", () => {
    const labels = latestLabels([ev("a", "skipped"), ev("a", "answered"), ev("b", "opened"), ev("c", "previewed")]);
    expect(labels.map((l) => [l.postId, l.action])).toEqual([["a", "answered"]]);
  });
});

describe("refitThreshold", () => {
  it("waits for enough labels from both classes", () => {
    expect(refitThreshold([ev("a", "answered", 0.9)], 0.6)).toBe(0);
    expect(refitThreshold(Array.from({ length: 10 }, (_, i) => ev(`p${i}`, "answered", 0.7)), 0.6)).toBe(0);
  });

  it("lowers the bar when you answer posts Jev scored below it", () => {
    const labels = [
      ...["a", "b", "c", "d", "e"].map((id) => ev(id, "answered", 0.5)),
      ...["f", "g", "h", "i", "j"].map((id) => ev(id, "skipped", 0.3)),
    ];
    const d = refitThreshold(labels, 0.6);
    expect(d).toBeLessThan(0);
    expect(0.6 + d).toBeLessThanOrEqual(0.5);
    expect(0.6 + d).toBeGreaterThan(0.3);
  });

  it("raises the bar when you skip posts above it", () => {
    const labels = [
      ...["a", "b", "c", "d"].map((id) => ev(id, "answered", 0.9)),
      ...["e", "f", "g", "h", "i"].map((id) => ev(id, "not-my-area", 0.65)),
    ];
    expect(refitThreshold(labels, 0.6)).toBeGreaterThan(0);
  });

  it("never moves more than 0.15", () => {
    const labels = [
      ...["a", "b", "c", "d", "e"].map((id) => ev(id, "answered", 0.05)),
      ...["f", "g", "h", "i", "j"].map((id) => ev(id, "skipped", 0.01)),
    ];
    expect(Math.abs(refitThreshold(labels, 0.6))).toBeLessThanOrEqual(0.15);
  });

  it("stays put when the labels are already separated at the base", () => {
    const labels = [
      ...["a", "b", "c", "d"].map((id) => ev(id, "answered", 0.8)),
      ...["e", "f", "g", "h"].map((id) => ev(id, "skipped", 0.4)),
    ];
    expect(refitThreshold(labels, 0.6)).toBe(0);
  });
});

describe("subredditOffsets", () => {
  it("lowers the bar where you answer most, raises it where you skip most, ignores thin data", () => {
    const labels = [
      ...["a", "b", "c", "d"].map((id) => ev(id, "answered", 0.6, { subreddit: "n8n" })),
      ...["e", "f", "g", "h"].map((id) => ev(id, "skipped", 0.6, { subreddit: "SideProject" })),
      ev("i", "skipped", 0.6, { subreddit: "shopify" }),
    ];
    expect(subredditOffsets(labels)).toEqual({ n8n: -0.1, sideproject: 0.1 });
  });
});

describe("keywordWeights", () => {
  it("moves weights by label and clamps to 0..3", () => {
    const w = keywordWeights([
      ev("a", "answered", 0.6, { hits: ["n8n::webhook"] }),
      ev("b", "not-my-area", 0.6, { hits: ["shop::liquid"] }),
      ...Array.from({ length: 10 }, (_, i) => ev(`s${i}`, "skipped", 0.6, { hits: ["x::api"] })),
    ]);
    expect(w["n8n::webhook"]).toBeCloseTo(1.25);
    expect(w["shop::liquid"]).toBeCloseTo(0.65);
    expect(w["x::api"]).toBe(0);
  });
});

describe("learn + effectiveThreshold", () => {
  it("combines base, global delta and subreddit offset within bounds", () => {
    const learned = { ...EMPTY_LEARNED, thresholdDelta: -0.1, subredditOffsets: { n8n: -0.1 } };
    expect(effectiveThreshold(0.6, learned, "N8N")).toBeCloseTo(0.4);
    expect(effectiveThreshold(0.6, learned, "other")).toBeCloseTo(0.5);
    expect(effectiveThreshold(0.1, EMPTY_LEARNED, "x")).toBe(0.2);
  });

  it("counts labelled posts", () => {
    expect(learn([ev("a", "answered"), ev("b", "opened")], 0.6, 5)).toMatchObject({ labelled: 1, updatedAt: 5 });
  });
});

describe("event log", () => {
  it("caps the log length, dropping the oldest", () => {
    let log: FeedbackEvent[] = [];
    for (let i = 0; i < MAX_EVENTS + 5; i++) log = appendEvent(log, ev(`p${i}`, "previewed"));
    expect(log).toHaveLength(MAX_EVENTS);
    expect(log[0]!.postId).toBe("p5");
  });

  it("answeredIds follows the latest label", () => {
    expect([...answeredIds([ev("a", "answered"), ev("a", "skipped"), ev("b", "answered")])]).toEqual(["b"]);
  });
});
