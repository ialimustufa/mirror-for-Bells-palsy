import assert from "node:assert/strict";
import test from "node:test";
import { recoveryColor } from "../src/ui/scoreFormatting.js";

const GREEN = "#7A8F73";
const AMBER = "#D4A574";
const RED = "#B8543A";
const GRAY = "#A8A29E";

test("recoveryColor centers the neutral point at baseline (1.0), not at a symmetry score", () => {
  assert.equal(recoveryColor(null), GRAY, "no data => gray");
  assert.equal(recoveryColor(1.5), GREEN, "well above baseline => improving");
  assert.equal(recoveryColor(1.15), GREEN, "115% of baseline => improving");
  assert.equal(recoveryColor(1.0), AMBER, "exactly baseline => neutral, not red");
  assert.equal(recoveryColor(0.9), AMBER, "near baseline => neutral");
  assert.equal(recoveryColor(0.84), RED, "clearly below baseline => regressed");
  // A ratio of ~0.5 — which the per-rep min/max symmetry heatmap would have painted red —
  // is below baseline here too, but the point is the SCALE is movement-vs-baseline, so a day
  // the affected side moved MORE than baseline reads green regardless of instantaneous balance.
  assert.equal(recoveryColor(2.0), GREEN, "affected side moving double its baseline => green");
});
