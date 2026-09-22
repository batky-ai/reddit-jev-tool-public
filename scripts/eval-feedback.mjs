#!/usr/bin/env node
// Offline check of how well Jev's match score predicts the posts you actually
// answer. Input: the JSON from the options page's "Export feedback JSON".
//   node scripts/eval-feedback.mjs ~/Downloads/reddit-jev-feedback-2026-09-22.json
// Positive = "answered"; negative = "skipped" or "not-my-area". Latest label per post wins.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/eval-feedback.mjs <feedback.json>");
  process.exit(2);
}
const events = JSON.parse(readFileSync(file, "utf8"));
const latest = new Map();
for (const e of events) {
  if (!["answered", "skipped", "not-my-area"].includes(e.action) || e.match == null) continue;
  const prev = latest.get(e.postId);
  if (!prev || e.at >= prev.at) latest.set(e.postId, e);
}
const labels = [...latest.values()];
const pos = labels.filter((e) => e.action === "answered").length;
console.log(`Labelled posts with a match score: ${labels.length} (answered ${pos}, skipped/not-my-area ${labels.length - pos})`);
if (labels.length < 8 || pos === 0 || pos === labels.length) {
  console.log("Not enough labels from both classes to evaluate yet (need 8+ with some of each).");
  process.exit(0);
}

console.log("\nthreshold  precision  recall  F1     highlighted");
let best = { t: 0, f1: -1 };
for (let t = 0.3; t <= 0.9 + 1e-9; t += 0.05) {
  let tp = 0, fp = 0, fn = 0;
  for (const e of labels) {
    const hit = e.match >= t;
    if (hit && e.action === "answered") tp++;
    else if (hit) fp++;
    else if (e.action === "answered") fn++;
  }
  const p = tp + fp ? tp / (tp + fp) : 0;
  const r = tp + fn ? tp / (tp + fn) : 0;
  const f1 = p + r ? (2 * p * r) / (p + r) : 0;
  if (f1 > best.f1) best = { t, f1 };
  console.log(`${t.toFixed(2).padStart(9)}  ${p.toFixed(2).padStart(9)}  ${r.toFixed(2).padStart(6)}  ${f1.toFixed(2)}   ${tp + fp}`);
}
console.log(`\nBest F1 ${best.f1.toFixed(2)} at threshold ${best.t.toFixed(2)}.`);

const byCard = new Map();
for (const e of labels) {
  const k = e.bestCard ?? "(no card)";
  const c = byCard.get(k) ?? { yes: 0, all: 0 };
  c.all++;
  if (e.action === "answered") c.yes++;
  byCard.set(k, c);
}
console.log("\nAnswer rate by best-matching card:");
for (const [k, c] of [...byCard].sort((a, b) => b[1].all - a[1].all)) {
  console.log(`  ${k.padEnd(40)} ${c.yes}/${c.all}`);
}
