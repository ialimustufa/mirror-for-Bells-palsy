import assert from "node:assert/strict";
import test from "node:test";
import { computeExerciseSymmetry } from "../src/ml/faceMetrics.js";

const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const LEFT_EYE_TOP = [173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE_TOP = [398, 384, 385, 386, 387, 388, 466];
const LEFT_EYE_BOTTOM = [7, 163, 144, 145, 153, 154, 155];
const RIGHT_EYE_BOTTOM = [249, 390, 373, 374, 380, 381, 382];
const LEFT_PUCKER = [61, 91, 146, 78, 185, 95, 88, 178, 40, 39, 37, 0];
const RIGHT_PUCKER = [291, 321, 375, 308, 409, 324, 318, 402, 270, 269, 267, 0];
const LEFT_WATER = [205, 192, 213, 50, 187, 147, 36, 142, 207, 216, 61, 84, 91, 146];
const RIGHT_WATER = [425, 416, 433, 280, 411, 376, 266, 371, 427, 436, 291, 314, 321, 375];
const LEFT_WATER_SEAL = [61, 84, 91, 146, 78, 95, 88, 178];
const RIGHT_WATER_SEAL = [291, 314, 321, 375, 308, 324, 318, 402];

function landmark(x, y, z = 0) {
  return { x, y, z };
}

function setGroup(lm, idxs, x, y) {
  for (const idx of idxs) lm[idx] = landmark(x, y);
}

function cloneLandmarks(lm) {
  return lm.map((point) => ({ ...point }));
}

function moveGroup(lm, idxs, dx, dy) {
  for (const idx of idxs) lm[idx] = landmark(lm[idx].x + dx, lm[idx].y + dy, lm[idx].z ?? 0);
}

function makeNeutralFace() {
  const lm = Array.from({ length: 478 }, () => landmark(0.5, 0.5));
  lm[1] = landmark(0.5, 0.5);
  lm[33] = landmark(0.3, 0.5);
  lm[263] = landmark(0.7, 0.5);
  setGroup(lm, LEFT_EYE, 0.34, 0.42);
  setGroup(lm, RIGHT_EYE, 0.66, 0.42);
  setGroup(lm, LEFT_EYE_TOP, 0.34, 0.40);
  setGroup(lm, RIGHT_EYE_TOP, 0.66, 0.40);
  setGroup(lm, LEFT_EYE_BOTTOM, 0.34, 0.46);
  setGroup(lm, RIGHT_EYE_BOTTOM, 0.66, 0.46);
  setGroup(lm, LEFT_PUCKER, 0.43, 0.58);
  setGroup(lm, RIGHT_PUCKER, 0.57, 0.58);
  setGroup(lm, LEFT_WATER, 0.40, 0.57);
  setGroup(lm, RIGHT_WATER, 0.60, 0.57);
  setGroup(lm, LEFT_WATER_SEAL, 0.44, 0.58);
  setGroup(lm, RIGHT_WATER_SEAL, 0.56, 0.58);
  return lm;
}

test("blink scores like soft eye closure", () => {
  const neutral = makeNeutralFace();
  const current = cloneLandmarks(neutral);
  moveGroup(current, [...LEFT_EYE_TOP, ...RIGHT_EYE_TOP], 0, 0.012);
  moveGroup(current, [...LEFT_EYE_BOTTOM, ...RIGHT_EYE_BOTTOM], 0, -0.012);

  const eyeClose = computeExerciseSymmetry("eye-close", current, neutral);
  const blink = computeExerciseSymmetry("blink", current, neutral);

  assert.ok(blink);
  assert.deepEqual(blink, eyeClose);
});

test("emoji pucker scores like pucker", () => {
  const neutral = makeNeutralFace();
  const current = cloneLandmarks(neutral);
  moveGroup(current, LEFT_PUCKER, 0.006, 0);
  moveGroup(current, RIGHT_PUCKER, -0.006, 0);

  const pucker = computeExerciseSymmetry("pucker", current, neutral);
  const emojiPucker = computeExerciseSymmetry("emoji-pucker", current, neutral);

  assert.ok(emojiPucker);
  assert.deepEqual(emojiPucker, pucker);
});

test("water hold left scores target-side seal quality", () => {
  const neutral = makeNeutralFace();
  const current = cloneLandmarks(neutral);
  // Raw image-right maps back to the user's left side.
  moveGroup(current, RIGHT_WATER, 0.006, 0);

  const result = computeExerciseSymmetry("water-hold-left", current, neutral);

  assert.ok(result);
  assert.equal(result.scoreType, "side-seal-proxy");
  assert.equal(result.targetSide, "left");
  assert.ok(result.symmetry > 0.95);
  assert.ok(result.leftDisp > result.rightDisp);
});

test("water hold right scores target-side seal quality", () => {
  const neutral = makeNeutralFace();
  const current = cloneLandmarks(neutral);
  // Raw image-left maps back to the user's right side.
  moveGroup(current, LEFT_WATER, -0.006, 0);

  const result = computeExerciseSymmetry("water-hold-right", current, neutral);

  assert.ok(result);
  assert.equal(result.scoreType, "side-seal-proxy");
  assert.equal(result.targetSide, "right");
  assert.ok(result.symmetry > 0.95);
  assert.ok(result.rightDisp > result.leftDisp);
});

test("water hold quality drops when the opposite side also moves", () => {
  const neutral = makeNeutralFace();
  const clean = cloneLandmarks(neutral);
  moveGroup(clean, RIGHT_WATER, 0.006, 0);
  const noisy = cloneLandmarks(clean);
  moveGroup(noisy, LEFT_WATER, -0.006, 0);

  const cleanScore = computeExerciseSymmetry("water-hold-left", clean, neutral);
  const noisyScore = computeExerciseSymmetry("water-hold-left", noisy, neutral);

  assert.ok(cleanScore);
  assert.ok(noisyScore);
  assert.ok(noisyScore.symmetry < cleanScore.symmetry);
});

test("water hold quality drops when target-side seal opens", () => {
  const neutral = makeNeutralFace();
  const clean = cloneLandmarks(neutral);
  moveGroup(clean, RIGHT_WATER, 0.006, 0);
  const leaking = cloneLandmarks(clean);
  moveGroup(leaking, [321, 375, 318, 402], 0, 0.08);

  const cleanScore = computeExerciseSymmetry("water-hold-left", clean, neutral);
  const leakingScore = computeExerciseSymmetry("water-hold-left", leaking, neutral);

  assert.ok(cleanScore);
  assert.ok(leakingScore);
  assert.ok(leakingScore.symmetry < cleanScore.symmetry);
});

test("a scored water hold is floored at 50% so it does not drag the session average", () => {
  const neutral = makeNeutralFace();
  // A poor but real hold: target side moves, but the opposite side moves heavily and the seal
  // leaks — raw quality target/(target+penalty) lands well below 0.5. The floor keeps a scored
  // hold at >= 50% (a one-sided isolation is not a left/right symmetry), while a clean hold still
  // scores higher, preserving the ordering.
  const poor = cloneLandmarks(neutral);
  moveGroup(poor, RIGHT_WATER, 0.006, 0);
  moveGroup(poor, LEFT_WATER, -0.006, 0);
  moveGroup(poor, [321, 375, 318, 402], 0, 0.08);
  const clean = cloneLandmarks(neutral);
  moveGroup(clean, RIGHT_WATER, 0.006, 0);

  const poorScore = computeExerciseSymmetry("water-hold-left", poor, neutral);
  const cleanScore = computeExerciseSymmetry("water-hold-left", clean, neutral);
  assert.ok(poorScore && cleanScore);
  assert.ok(poorScore.symmetry >= 0.5, "a scored hold is floored at 50%");
  assert.ok(poorScore.symmetry < cleanScore.symmetry, "a poor hold still scores below a clean one");
  assert.ok(cleanScore.symmetry <= 1, "a clean hold stays within 100%");
});
