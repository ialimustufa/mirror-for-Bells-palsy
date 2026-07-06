// Calibrate the directional signal gate against captured frames. Captures each directional
// hold frame's peak + per-side noise + (geometry) symmetry ONCE under a permissive gate, then
// re-derives the admit decision for candidate gate constants in pure arithmetic (cap/multiplier
// don't change peak or symmetry, only whether a frame counts). Reports, per candidate:
//   - sessionAvg per in-window session (vs pre-revamp gate and stored)
//   - coverage (exercises that still score)
//   - the noise-vs-signal split: how many admitted frames sit at/below the noise floor
// so we can choose a gate that keeps subtle exercises scorable without scoring noise.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  averageBlendshapes, averageFacialTransformationMatrix, averageLandmarks, computeNoiseFloor,
  computeExerciseSymmetryDiagnostic, exerciseUsesBlendshapeFusion,
} from "../src/ml/faceMetrics.js";

const path = process.argv[2];
const sinceTs = Date.now() - 5 * 86400000;
const PERMISSIVE = { scoringNoiseOverrides: { directionalGateMultiplier: 0, directionalGateCap: 0 } };

const inWindow = new Map();
const framesBySession = new Map();
for (let pass = 0; pass < 2; pass++) {
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue; let item; try { item = JSON.parse(line); } catch { continue; }
    if (pass === 0 && item.store === "sessions" && (item.record?.ts ?? 0) >= sinceTs) {
      inWindow.set(item.record.id, { date: item.record.date, sessionAvg: item.record.sessionAvg });
    } else if (pass === 1 && (item.store === "sessionFrameSamples" || item.store === "frameSamples") && inWindow.has(item.record?.sessionId)) {
      const sid = item.record.sessionId;
      if (!framesBySession.has(sid)) framesBySession.set(sid, []);
      framesBySession.get(sid).push(item.record);
    }
  }
}

const lm = (s) => Array.isArray(s?.landmarks) ? s.landmarks : Array.isArray(s?.rawLandmarks) ? s.rawLandmarks : null;
const mx = (s) => s?.facialTransformationMatrix ?? s?.rawFacialTransformationMatrix ?? null;
const mean = (a) => { const f = a.filter(Number.isFinite); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : null; };

function calibrate(frames) {
  const buf = frames.filter((f) => f.phase === "calibrate");
  const lms = buf.map(lm).filter(Boolean); if (!lms.length) return null;
  const mats = buf.map(mx).filter(Boolean);
  const neutral = averageLandmarks(lms);
  const neutralMatrix = averageFacialTransformationMatrix(mats);
  return { neutral, neutralMatrix, noiseFloor: computeNoiseFloor(lms, neutral, mats, neutralMatrix), neutralBs: averageBlendshapes(buf.map((f) => f.blendshapes).filter(Boolean)) };
}

// Capture per-frame directional records once (permissive gate => nearly all frames scored).
const records = []; // {sid, date, exerciseId, repIndex, peak, maxNoise, symmetry, minSignal}
for (const [sid, meta] of inWindow) {
  const frames = framesBySession.get(sid); if (!frames) continue;
  const cal = calibrate(frames); if (!cal) continue;
  for (const f of frames) {
    if (f.phase !== "hold") continue;
    const d = computeExerciseSymmetryDiagnostic(f.exerciseId, lm(f), cal.neutral, cal.noiseFloor, f.blendshapes ?? null, cal.neutralBs, mx(f), cal.neutralMatrix, PERMISSIVE);
    const r = d?.result;
    if (!r || !r.directionalKey || !Number.isFinite(r.peak) || !Number.isFinite(r.symmetry)) continue;
    records.push({ sid, date: meta.date, exerciseId: f.exerciseId, repIndex: f.repIndex ?? 0, peak: r.peak, maxNoise: Math.max(r.leftNoise ?? 0, r.rightNoise ?? 0), symmetry: r.symmetry, minSignal: r.minSignal ?? 0 });
  }
}

const gateFor = (rec, mult, cap) => Math.max(rec.minSignal, Math.min(rec.maxNoise * mult, cap));
function sessionAvgs(mult, cap) {
  // group records by session->exercise->rep, admit if peak >= gate
  const bySession = new Map();
  for (const rec of records) {
    if (rec.peak < gateFor(rec, mult, cap)) continue;
    if (!bySession.has(rec.sid)) bySession.set(rec.sid, new Map());
    const byEx = bySession.get(rec.sid);
    if (!byEx.has(rec.exerciseId)) byEx.set(rec.exerciseId, new Map());
    const reps = byEx.get(rec.exerciseId);
    if (!reps.has(rec.repIndex)) reps.set(rec.repIndex, []);
    reps.get(rec.repIndex).push(rec.symmetry);
  }
  const out = new Map();
  for (const [sid, byEx] of bySession) {
    const exAvg = [];
    for (const reps of byEx.values()) { const a = mean([...reps.values()].map(mean)); if (a != null) exAvg.push(a); }
    out.set(sid, { avg: mean(exAvg), exCount: byEx.size });
  }
  return out;
}

const CANDIDATES = [
  { label: "current (cap .012, m1)", mult: 1, cap: 0.012 },
  { label: "cap .02,  m1", mult: 1, cap: 0.02 },
  { label: "cap .03,  m1", mult: 1, cap: 0.03 },
  { label: "cap .05,  m1.5", mult: 1.5, cap: 0.05 },
  { label: "pre-revamp (m1.5,cap inf)", mult: 1.5, cap: Infinity },
];

const dates = [...inWindow.entries()].sort((a, b) => (a[1].date ?? "").localeCompare(b[1].date ?? ""));
const pct = (v) => v?.avg == null ? "  --" : `${(v.avg * 100).toFixed(0)}%/${v.exCount}`;
console.log(`Directional gate calibration — ${records.length} directional hold frames across ${framesBySession.size} sessions\n`);
console.log("(cell = sessionAvg% / #directional-exercises-scored)\n");
let header = "candidate".padEnd(26);
for (const [, m] of dates) header += (m.date ?? "?").slice(5).padStart(9);
console.log(header);
for (const c of CANDIDATES) {
  const res = sessionAvgs(c.mult, c.cap);
  let row = c.label.padEnd(26);
  for (const [sid] of dates) row += pct(res.get(sid)).padStart(9);
  console.log(row);
}
let stored = "stored".padEnd(26);
for (const [, m] of dates) stored += (m.sessionAvg != null ? `${(m.sessionAvg * 100).toFixed(0)}%` : "--").padStart(9);
console.log(stored);

// Per (day, exercise) symmetry over robustly-above-noise frames (>=1.5x noise floor).
console.log("\nPer-day symmetry over frames >=1.5x noise (genuine movement only):");
const days = [...new Set(records.map((r) => r.date))].sort();
for (const ex of [...new Set(records.map((r) => r.exerciseId))].sort()) {
  const tag = exerciseUsesBlendshapeFusion(ex) ? " [fusion]" : "";
  let row = `  ${ex}${tag}`.padEnd(26);
  for (const day of days) {
    const recs = records.filter((r) => r.exerciseId === ex && r.date === day && r.peak >= r.maxNoise * 1.5);
    const m = recs.length ? mean(recs.map((r) => r.symmetry)) : null;
    row += (m == null ? "--" : `${(m * 100).toFixed(0)}%(${recs.length})`).padStart(11);
  }
  console.log(row);
}
console.log(`  ${"".padEnd(24)}${days.map((d) => d.slice(5).padStart(11)).join("")}`);

// Noise-vs-signal: of frames admitted by the CURRENT gate, how many sit at/below the noise floor?
console.log("\nNoise-vs-signal at current gate (cap .012, m1):");
for (const ex of [...new Set(records.map((r) => r.exerciseId))].sort()) {
  const exRecs = records.filter((r) => r.exerciseId === ex && r.peak >= gateFor(r, 1, 0.012));
  if (!exRecs.length) continue;
  const nearNoise = exRecs.filter((r) => r.peak < r.maxNoise);          // peak below noise floor => indistinguishable from noise
  const supra = exRecs.filter((r) => r.peak >= r.maxNoise * 1.5);        // robustly above noise
  const tag = exerciseUsesBlendshapeFusion(ex) ? " [fusion]" : "";
  console.log(`  ${ex}${tag}: ${exRecs.length} admitted | <=noise: ${nearNoise.length} (sym ${nearNoise.length ? (mean(nearNoise.map((r) => r.symmetry)) * 100).toFixed(0) + "%" : "-"}) | >=1.5x noise: ${supra.length} (sym ${supra.length ? (mean(supra.map((r) => r.symmetry)) * 100).toFixed(0) + "%" : "-"})`);
}
