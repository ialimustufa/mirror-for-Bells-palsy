import assert from "node:assert/strict";
import test from "node:test";
import { effectiveProfileThreshold, profileLiveScoringThreshold } from "../src/ml/faceMetrics.js";

// Real captures showed eye-closure calibration occasionally inflating the baseline peak
// (a transient blink), producing an activation threshold (~0.51) far above the achievable
// aperture signal (~0.01-0.05) and force-skipping every rep. The eye-closure family must be
// capped like the nose family so a mis-scaled baseline can't make the gate unreachable.

test("eye-closure activation threshold is capped to the aperture scale", () => {
  for (const exerciseId of ["eye-close", "blink", "wink", "emoji-wink"]) {
    assert.equal(effectiveProfileThreshold(exerciseId, 0.51), 0.012, `${exerciseId} should cap an inflated threshold`);
    // A sane, low threshold from a good calibration is left untouched.
    assert.equal(effectiveProfileThreshold(exerciseId, 0.008), 0.008, `${exerciseId} should keep a low threshold`);
  }
});

test("smile family clamps only grossly inflated thresholds", () => {
  // Healthy working thresholds (below the family ceiling) are left untouched.
  assert.equal(effectiveProfileThreshold("open-smile", 0.39), 0.39);
  assert.equal(effectiveProfileThreshold("closed-smile", 0.39), 0.39);
  // A transient-inflated baseline is clamped to the achievable scale.
  assert.equal(effectiveProfileThreshold("closed-smile", 1.2), 0.45);
  assert.equal(effectiveProfileThreshold("emoji-smirk", 1.2), 0.45);
});

test("pucker clamps the inflated baseline to a visible-movement floor", () => {
  // Captured pucker peaks are ~0.27-0.70 with near-zero noise, so a true minimumVisible band
  // (~20% of the ~0.5 median peak) is ~0.10. A non-inflated baseline derives below the cap and
  // is left untouched; the inflated ~0.43 (which dropped 23% of genuine reps) is now clamped.
  assert.equal(effectiveProfileThreshold("pucker", 0.10), 0.10);
  assert.equal(effectiveProfileThreshold("pucker", 0.43), 0.12);
  assert.equal(effectiveProfileThreshold("pucker", 1.2), 0.12);
  assert.equal(effectiveProfileThreshold("emoji-pucker", 0.43), 0.12);
});

test("cheek and lip-press families have grounded/provisional caps", () => {
  assert.equal(effectiveProfileThreshold("cheek-suck", 0.9), 0.18);
  assert.equal(effectiveProfileThreshold("cheek-suck", 0.05), 0.05);
  assert.equal(effectiveProfileThreshold("lip-press", 0.9), 0.1);
  assert.equal(effectiveProfileThreshold("lip-press", 0.04), 0.04);
});

test("unrelated exercises stay uncapped", () => {
  assert.equal(effectiveProfileThreshold("eyebrow-raise", 0.5), 0.5);
  assert.equal(effectiveProfileThreshold("vowel-a", 0.5), 0.5);
});

test("live scoring threshold caps the minimumVisible band for an inflated eye-close baseline", () => {
  // Inflated baseline: minimumVisible (peak*0.2) would be 0.3, but the cap keeps it reachable.
  const inflated = { activationThreshold: 0.51, thresholdBands: { minimumVisible: 0.3, reliableMovement: 0.51 } };
  assert.equal(profileLiveScoringThreshold("eye-close", inflated), 0.012);

  // Healthy baseline keeps its low visible band.
  const healthy = { activationThreshold: 0.0103, thresholdBands: { minimumVisible: 0.006, reliableMovement: 0.0103 } };
  assert.equal(profileLiveScoringThreshold("eye-close", healthy), 0.006);
});
