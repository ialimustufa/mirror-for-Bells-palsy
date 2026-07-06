import assert from "node:assert/strict";
import test from "node:test";
import { computeExerciseSymmetry } from "../src/ml/faceMetrics.js";

// Subtle directional exercises (eye closure, smile, cheek suck) fuse the matching
// MediaPipe blendshape into the activation gate only: the assist rescues a rep from being
// dropped, but the symmetry RATIO is computed from geometry alone. The assist is gated per
// side on the geometry already moving in the correct direction, so a strong blendshape can
// neither fabricate a score on a side that is not moving nor distort the left/right ratio
// (guards against the model's tendency to report a stronger blendshape on the healthy side
// of an asymmetric face, which used to drag the symmetry score down).

const LEFT_CHEEK = [205, 192, 213, 50, 187, 147, 36, 142, 207, 216];
const RIGHT_CHEEK = [425, 416, 433, 280, 411, 376, 266, 371, 427, 436];
const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const LEFT_EYE_TOP = [173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE_TOP = [398, 384, 385, 386, 387, 388, 466];
const LEFT_EYE_BOTTOM = [7, 163, 144, 145, 153, 154, 155];
const RIGHT_EYE_BOTTOM = [249, 390, 373, 374, 380, 381, 382];
const LEFT_SMILE = [61, 84, 91, 146, 78, 95, 88, 178, 39, 40, 181];
const RIGHT_SMILE = [291, 314, 321, 375, 308, 324, 318, 402, 269, 270, 405];

function landmark(x, y, z = 0) {
  return { x, y, z };
}

function cloneLandmarks(lm) {
  return lm.map((point) => ({ ...point }));
}

function setGroup(lm, idxs, x, y) {
  for (const idx of idxs) lm[idx] = landmark(x, y);
}

function moveGroup(lm, idxs, dx, dy) {
  for (const idx of idxs) lm[idx] = landmark(lm[idx].x + dx, lm[idx].y + dy, lm[idx].z ?? 0);
}

function makeNeutralFace() {
  const lm = Array.from({ length: 478 }, () => landmark(0.5, 0.5));
  lm[33] = landmark(0.3, 0.46);
  lm[263] = landmark(0.7, 0.46);
  lm[0] = landmark(0.5, 0.57);
  setGroup(lm, LEFT_SMILE, 0.43, 0.58);
  setGroup(lm, RIGHT_SMILE, 0.57, 0.58);
  setGroup(lm, LEFT_CHEEK, 0.36, 0.54);
  setGroup(lm, RIGHT_CHEEK, 0.64, 0.54);
  setGroup(lm, LEFT_EYE, 0.34, 0.46);
  setGroup(lm, RIGHT_EYE, 0.66, 0.46);
  setGroup(lm, LEFT_EYE_TOP, 0.34, 0.43);
  setGroup(lm, RIGHT_EYE_TOP, 0.66, 0.43);
  setGroup(lm, LEFT_EYE_BOTTOM, 0.34, 0.49);
  setGroup(lm, RIGHT_EYE_BOTTOM, 0.66, 0.49);
  return lm;
}

test("blendshape assist rescues a subtle eye closure that the geometry alone drops", () => {
  const neutral = makeNeutralFace();
  // Aperture decrease small enough to sit between the direction floor and the gate.
  const subtle = cloneLandmarks(neutral);
  moveGroup(subtle, [...LEFT_EYE_TOP, ...RIGHT_EYE_TOP], 0, 0.0007);
  moveGroup(subtle, [...LEFT_EYE_BOTTOM, ...RIGHT_EYE_BOTTOM], 0, -0.0007);

  const withoutBlendshape = computeExerciseSymmetry("eye-close", subtle, neutral, undefined, null, null);
  const strongBlink = { eyeBlinkLeft: 0.7, eyeBlinkRight: 0.7 };
  const withBlendshape = computeExerciseSymmetry("eye-close", subtle, neutral, undefined, strongBlink, {});

  assert.equal(withoutBlendshape, null, "geometry-only subtle closure should fall below the gate");
  assert.ok(withBlendshape, "blendshape-assisted subtle closure should score");
  assert.ok(withBlendshape.peak > 0, "assisted peak should be positive");
});

test("eye closure scores the lid convergence, not penalized for the upper lid leading", () => {
  const neutral = makeNeutralFace();
  // Two closures with the SAME aperture reduction (0.01 per eye):
  // A) upper-lid dominant — the natural close: top descends 0.01, bottom static.
  const topDominant = cloneLandmarks(neutral);
  moveGroup(topDominant, [...LEFT_EYE_TOP, ...RIGHT_EYE_TOP], 0, 0.01);
  // B) symmetric convergence: top descends 0.005, bottom rises 0.005.
  const symmetric = cloneLandmarks(neutral);
  moveGroup(symmetric, [...LEFT_EYE_TOP, ...RIGHT_EYE_TOP], 0, 0.005);
  moveGroup(symmetric, [...LEFT_EYE_BOTTOM, ...RIGHT_EYE_BOTTOM], 0, -0.005);

  const a = computeExerciseSymmetry("eye-close", topDominant, neutral, undefined, null, null);
  const b = computeExerciseSymmetry("eye-close", symmetric, neutral, undefined, null, null);
  assert.ok(a && b, "both closures should score on geometry alone");
  // Same aperture change => same signal. The previous center-shift penalty halved the
  // top-lid-dominant close; convergence is now scored directly, so the two agree.
  assert.ok(Math.abs(a.peak - b.peak) < 1e-9, "upper-lid-dominant close must not be attenuated");
});

test("blendshape cannot fabricate a score in the opposite direction", () => {
  const neutral = makeNeutralFace();
  // Eye opening (aperture increase) is the opposite of eye closure, so there is no
  // closure direction for the assist to attach to.
  const opening = cloneLandmarks(neutral);
  moveGroup(opening, [...LEFT_EYE_TOP, ...RIGHT_EYE_TOP], 0, -0.01);
  moveGroup(opening, [...LEFT_EYE_BOTTOM, ...RIGHT_EYE_BOTTOM], 0, 0.01);

  const maxedBlink = { eyeBlinkLeft: 1, eyeBlinkRight: 1 };
  const result = computeExerciseSymmetry("eye-close", opening, neutral, undefined, maxedBlink, {});

  assert.equal(result, null, "a maxed eye-blink blendshape must not score when the eye is opening");
});

test("blendshape assist increases smile and cheek-suck signal without lowering it", () => {
  const neutral = makeNeutralFace();

  const smile = cloneLandmarks(neutral);
  moveGroup(smile, LEFT_SMILE, -0.004, -0.003);
  moveGroup(smile, RIGHT_SMILE, 0.004, -0.003);
  const smileNoBs = computeExerciseSymmetry("closed-smile", smile, neutral, undefined, null, null);
  const smileWithBs = computeExerciseSymmetry("closed-smile", smile, neutral, undefined, { mouthSmileLeft: 0.6, mouthSmileRight: 0.6 }, {});
  assert.ok(smileWithBs, "smile should score");
  assert.ok(!smileNoBs || smileWithBs.peak >= smileNoBs.peak, "blendshape assist should not reduce smile signal");

  const suck = cloneLandmarks(neutral);
  moveGroup(suck, LEFT_CHEEK, 0.004, 0);
  moveGroup(suck, RIGHT_CHEEK, -0.004, 0);
  const suckNoBs = computeExerciseSymmetry("cheek-suck", suck, neutral, undefined, null, null);
  const suckWithBs = computeExerciseSymmetry("cheek-suck", suck, neutral, undefined, { cheekSquintLeft: 0.6, cheekSquintRight: 0.6 }, {});
  assert.ok(suckWithBs, "cheek suck should score");
  assert.ok(!suckNoBs || suckWithBs.peak >= suckNoBs.peak, "blendshape assist should not reduce cheek-suck signal");
});

test("a one-sided blendshape no longer drags the symmetry ratio down", () => {
  const neutral = makeNeutralFace();
  // Asymmetric smile: a strong pull on the image-left, a weak twitch on the right —
  // the classic palsy shape the geometry should report as low symmetry.
  const smile = cloneLandmarks(neutral);
  moveGroup(smile, LEFT_SMILE, -0.02, -0.012);
  moveGroup(smile, RIGHT_SMILE, 0.004, -0.002);

  const geomOnly = computeExerciseSymmetry("closed-smile", smile, neutral, undefined, null, null);
  assert.ok(geomOnly, "asymmetric smile should score on geometry alone");
  assert.ok(geomOnly.symmetry < 0.6, "geometry should read the smile as clearly asymmetric");

  // Blendshape fires hard on the strong (moving) side and not on the weak side — exactly
  // the pattern that previously inflated the healthy side and lowered min/max symmetry.
  const oneSided = computeExerciseSymmetry("closed-smile", smile, neutral, undefined, { mouthSmileLeft: 0.9, mouthSmileRight: 0 }, {});
  assert.ok(oneSided, "still scores with the blendshape present");
  assert.ok(
    Math.abs(oneSided.symmetry - geomOnly.symmetry) < 1e-9,
    "a one-sided blendshape must not change the symmetry ratio",
  );
  assert.ok(oneSided.peak >= geomOnly.peak, "the assist should still flow into the (gate) peak");
});

test("movement seen only through the blendshape is dropped, not scored 0%", () => {
  const neutral = makeNeutralFace();
  // No geometric movement at all (current === neutral): there is no left/right balance to
  // score. A maxed blink must not produce a fabricated symmetry; the rep is dropped.
  const still = cloneLandmarks(neutral);
  const result = computeExerciseSymmetry("eye-close", still, neutral, undefined, { eyeBlinkLeft: 1, eyeBlinkRight: 1 }, {});
  assert.equal(result, null, "no geometry => no score, even with a maxed blendshape");
});
