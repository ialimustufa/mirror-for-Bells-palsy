import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, RefreshCw, Loader2, AlertCircle, ArrowLeft, X as CloseIcon } from "lucide-react";

// Brand glyphs aren't shipped by lucide-react v1 (dropped for trademark reasons), so
// inline the three we need. Single-path SVGs, currentColor so the button styles win.
function GithubGlyph({ className = "w-3.5 h-3.5" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.8 10.9.6.1.8-.2.8-.6v-2.2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6 4.5-1.5 7.8-5.8 7.8-10.9C23.5 5.7 18.3.5 12 .5z"/>
    </svg>
  );
}
function LinkedinGlyph({ className = "w-3.5 h-3.5" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M20.5 2h-17A1.5 1.5 0 0 0 2 3.5v17A1.5 1.5 0 0 0 3.5 22h17a1.5 1.5 0 0 0 1.5-1.5v-17A1.5 1.5 0 0 0 20.5 2zM8 19H5v-9h3v9zM6.5 8.25A1.75 1.75 0 1 1 8.3 6.5a1.78 1.78 0 0 1-1.8 1.75zM19 19h-3v-4.74c0-1.42-.6-1.93-1.38-1.93A1.74 1.74 0 0 0 13 14.19a.66.66 0 0 0 0 .14V19h-3v-9h2.9v1.3a3.11 3.11 0 0 1 2.7-1.4c1.55 0 3.36.86 3.36 3.66z"/>
    </svg>
  );
}
function XGlyph({ className = "w-3.5 h-3.5" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}
import { CALIBRATION_FRAMES, CALIBRATION_RESET_EPS } from "../domain/config";
import { useCameraStream } from "../hooks/useCameraStream";
import { useFaceLandmarker } from "../hooks/useFaceLandmarker";
import { CameraSetupStatusPanel } from "../components/appViews";
import { MadeByFooter } from "../components/MadeByFooter";
import {
  averageBlendshapes,
  averageFacialTransformationMatrix,
  averageLandmarks,
  calibrationPrompt,
  computeNoiseFloor,
  faceAlignmentFeedback,
  firstFacialTransformationMatrix,
  headPoseDeviationRad,
  normalizeScoringNoiseMode,
  normalizedFrameDelta,
  objectCoverTransform,
  smoothFacialTransformationMatrix,
  smoothLandmarks,
} from "../ml/faceMetrics";

const OPENAI_SUPPORT_URL = "https://developers.openai.com/?utm_source=mirror-for-bells-palsy&utm_medium=referral&utm_campaign=try-page&utm_content=openai-credit";
const RENDER_SUPPORT_URL = "https://render.com/?utm_source=mirror-for-bells-palsy&utm_medium=referral&utm_campaign=try-page&utm_content=render-credit";

function SupportCreditText({ className = "" }) {
  return (
    <p className={className}>
      Supported by{" "}
      <a href={OPENAI_SUPPORT_URL} target="_blank" rel="noreferrer" className="font-semibold underline decoration-stone-400 underline-offset-4 hover:text-stone-900">
        OpenAI
      </a>{" "}
      with $600 in credits and{" "}
      <a href={RENDER_SUPPORT_URL} target="_blank" rel="noreferrer" className="font-semibold underline decoration-stone-400 underline-offset-4 hover:text-stone-900">
        Render
      </a>{" "}
      with $250 in credits.
    </p>
  );
}

function SupportedByCard({ className = "" }) {
  return (
    <section className={className} style={{ background: "rgba(31,27,22,0.04)", border: "1px solid rgba(31,27,22,0.08)" }}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500 mb-2">Supported by</div>
      <SupportCreditText className="text-sm text-stone-700 leading-relaxed" />
    </section>
  );
}

function DismissibleSupportHeader({ onDismiss }) {
  return (
    <section className="mb-5 lg:mb-6 rounded-2xl px-4 py-3 lg:px-5 flex items-start gap-3" style={{ background: "#FFFFFF", border: "1px solid rgba(31,27,22,0.08)", boxShadow: "0 14px 40px rgba(31,27,22,0.06)" }}>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500 mb-1">Supported by</div>
        <SupportCreditText className="text-sm text-stone-700 leading-relaxed" />
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
        style={{ background: "rgba(31,27,22,0.06)", color: "#57534E" }}
        aria-label="Dismiss supported by notice"
      >
        <CloseIcon className="w-4 h-4" />
      </button>
    </section>
  );
}

// Blendshapes we surface in the muscle-activity panel. Each row carries a `cap` — the
// approximate maximum value MediaPipe emits for that blendshape during a real-world
// expression. Smile/sneer/cheek-squint cap around 0.25–0.5; brow lift can reach 0.7;
// eye close reaches 0.95. Scaling bar fills by `value/cap` is what makes the demo
// feel "alive" — a casual smile fills the bar, not a sliver. `glow` indices steer the
// activation glow drawn on the camera (subject-perspective L/R landmark indices).
const FEATURED_BLENDSHAPES = [
  { label: "Brow up",      left: "browOuterUpLeft",  right: "browOuterUpRight", cap: 0.6,  glow: [105, 334], color: "#D4A574" },
  { label: "Brow down",    left: "browDownLeft",     right: "browDownRight",    cap: 0.5,  glow: [70, 300],  color: "#B8543A" },
  { label: "Eye close",    left: "eyeBlinkLeft",     right: "eyeBlinkRight",    cap: 0.95, glow: [159, 386], color: "#7A8F73" },
  { label: "Nose sneer",   left: "noseSneerLeft",    right: "noseSneerRight",   cap: 0.25, glow: [49, 279],  color: "#D4A574" },
  { label: "Cheek squint", left: "cheekSquintLeft",  right: "cheekSquintRight", cap: 0.25, glow: [50, 280],  color: "#D4A574" },
  { label: "Smile",        left: "mouthSmileLeft",   right: "mouthSmileRight",  cap: 0.45, glow: [61, 291],  color: "#7A8F73" },
  { label: "Frown",        left: "mouthFrownLeft",   right: "mouthFrownRight",  cap: 0.35, glow: [91, 321],  color: "#B8543A" },
  { label: "Lip press",    left: "mouthPressLeft",   right: "mouthPressRight",  cap: 0.55, glow: [78, 308],  color: "#D4A574" },
  { label: "Jaw open",     single: "jawOpen",                                   cap: 0.6,  glow: [17, 152],  color: "#A78BCA" },
];

// Live expression detector — reads the blendshape map and returns the most plausible
// label. Thresholds are tuned against the per-blendshape caps above so the chip lights
// up at a normal effort level, not a maximum-strain one. Specificity order matters:
// open-smile must beat closed-smile when jawOpen is high; wink must beat eye-close
// when blink asymmetry is large; etc.
function detectExpression(bs) {
  if (!bs) return { label: "Neutral", emoji: "😐", strength: 0 };
  const v = (k) => bs[k] ?? 0;
  const smile = Math.max(v("mouthSmileLeft"), v("mouthSmileRight"));
  const browUp = Math.max(v("browOuterUpLeft"), v("browOuterUpRight"));
  const browDown = Math.max(v("browDownLeft"), v("browDownRight"));
  const sneer = Math.max(v("noseSneerLeft"), v("noseSneerRight"));
  const cheek = Math.max(v("cheekSquintLeft"), v("cheekSquintRight"));
  const frown = Math.max(v("mouthFrownLeft"), v("mouthFrownRight"));
  const blinkL = v("eyeBlinkLeft");
  const blinkR = v("eyeBlinkRight");
  const blink = Math.max(blinkL, blinkR);
  const blinkDiff = Math.abs(blinkL - blinkR);
  const jawOpen = v("jawOpen");
  const lipPress = Math.max(v("mouthPressLeft"), v("mouthPressRight"));

  if (browUp > 0.25 && jawOpen > 0.25) return { label: "Surprised", emoji: "😮", strength: Math.max(browUp, jawOpen) };
  if (smile > 0.18 && jawOpen > 0.25) return { label: "Open smile", emoji: "😄", strength: smile };
  if (blinkDiff > 0.4)                return { label: "Wink", emoji: "😉", strength: blinkDiff };
  if (smile > 0.15)                   return { label: "Smiling", emoji: "🙂", strength: smile };
  if (sneer > 0.12)                   return { label: "Nose scrunch", emoji: "😖", strength: sneer };
  if (browUp > 0.2)                   return { label: "Brow raise", emoji: "🤨", strength: browUp };
  if (browDown > 0.22)                return { label: "Brow furrow", emoji: "😠", strength: browDown };
  if (frown > 0.2)                    return { label: "Frowning", emoji: "🙁", strength: frown };
  if (blink > 0.7)                    return { label: "Eyes closed", emoji: "😑", strength: blink };
  if (lipPress > 0.4)                 return { label: "Lip press", emoji: "😬", strength: lipPress };
  if (cheek > 0.15)                   return { label: "Cheek squint", emoji: "😝", strength: cheek };
  return { label: "Neutral", emoji: "😐", strength: 0 };
}

// Standard MediaPipe FaceMesh contour landmark indices. Defined locally because the
// session-mode drawOverlay keeps these private; the trial wants a richer, ring-free
// rendering with region color-coding.
const MESH_FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const MESH_LEFT_BROW_LOWER  = [70, 63, 105, 66, 107];
const MESH_LEFT_BROW_UPPER  = [46, 53, 52, 65, 55];
const MESH_RIGHT_BROW_LOWER = [300, 293, 334, 296, 336];
const MESH_RIGHT_BROW_UPPER = [276, 283, 282, 295, 285];
const MESH_LEFT_EYE  = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const MESH_RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const MESH_LEFT_IRIS  = [468, 469, 470, 471, 472];
const MESH_RIGHT_IRIS = [473, 474, 475, 476, 477];
const MESH_NOSE_BRIDGE = [168, 6, 197, 195, 5, 4, 1];
const MESH_NOSE_BOTTOM = [98, 97, 2, 326, 327];
const MESH_LIPS_OUTER  = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const MESH_LIPS_INNER  = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
const MESH_FACE_MIDLINE = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 164, 0, 11, 12, 13, 14, 15, 16, 17, 18, 200, 199, 175, 152];

// Region color palette — each anatomical zone gets its own hue so the demo "divides
// the face into different colors" instead of one cream mesh.
const MESH_COLORS = {
  oval:  "rgba(244,239,230,0.55)",
  brow:  "#D4A574", // gold
  eye:   "#FF8E8E", // coral
  iris:  "#FFD56B", // amber
  nose:  "#A78BCA", // lavender
  lips:  "#FF6B7A", // pink
  lipsI: "rgba(255,107,122,0.55)",
  cheek: "#7A8F73", // sage
  mid:   "rgba(244,239,230,0.4)",
  dot:   "rgba(255,213,107,0.75)",
};

// Per-landmark color lookup — every index used by a contour gets its region color so the
// dot pass renders the face in distinct hues by region. Indices NOT in this table fall
// through to a faint cream dot so the full 478-point mesh is still visible.
const LANDMARK_COLOR_MAP = (() => {
  const m = {};
  const tag = (idxs, color) => idxs.forEach((i) => { m[i] = color; });
  tag([...MESH_LEFT_BROW_LOWER, ...MESH_LEFT_BROW_UPPER, ...MESH_RIGHT_BROW_LOWER, ...MESH_RIGHT_BROW_UPPER], MESH_COLORS.brow);
  tag([...MESH_LEFT_EYE, ...MESH_RIGHT_EYE], MESH_COLORS.eye);
  tag([...MESH_LEFT_IRIS, ...MESH_RIGHT_IRIS], MESH_COLORS.iris);
  tag([...MESH_NOSE_BRIDGE, ...MESH_NOSE_BOTTOM, 49, 279, 64, 294, 240, 460], MESH_COLORS.nose);
  tag([...MESH_LIPS_OUTER, ...MESH_LIPS_INNER], MESH_COLORS.lips);
  // Cheek apex / zygomatic anchor dots
  tag([50, 280, 205, 425, 187, 411, 117, 346, 101, 330], MESH_COLORS.cheek);
  return m;
})();

// Trial-specific mesh renderer — no posture ring, no clipping. Renders every landmark
// dot (color-coded by region), polylines for each feature contour, iris discs, dotted
// midline, and a sage highlight on the symmetry pairs used by the scorer.
function drawTrialMesh(canvas, video, lm, aligned = false) {
  if (!canvas || !video) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Centering ring (posture guide) — drawn first so the mesh dots sit on top.
  // Sage when aligned, amber when drifting.
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const ringR = Math.min(canvas.width, canvas.height) * 0.36;
  ctx.save();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = aligned ? "rgba(122,143,115,0.85)" : "rgba(212,165,116,0.55)";
  ctx.setLineDash([8 * dpr, 8 * dpr]);
  ctx.beginPath();
  ctx.ellipse(cx, cy, ringR * 0.78, ringR, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  if (!lm) return;
  const t = objectCoverTransform(canvas, video);
  if (!t) return;
  const px = (p) => t.cw - (p.x * t.dw + t.ox); // mirrored to match scaleX(-1)
  const py = (p) => p.y * t.dh + t.oy;

  // Pass 1 — dense dot pass for the full 478-point mesh.
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i]; if (!p) continue;
    const color = LANDMARK_COLOR_MAP[i];
    if (color) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(px(p), py(p), 1.6 * dpr, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = MESH_COLORS.dot;
      ctx.beginPath(); ctx.arc(px(p), py(p), 0.9 * dpr, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Pass 2 — feature contours.
  const stroke = (idxs, color, closed = false, width = 1.4) => {
    ctx.beginPath();
    idxs.forEach((i, k) => {
      const p = lm[i]; if (!p) return;
      const x = px(p), y = py(p);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (closed) ctx.closePath();
    ctx.strokeStyle = color; ctx.lineWidth = width * dpr; ctx.stroke();
  };
  stroke(MESH_FACE_OVAL,        MESH_COLORS.oval,  true,  1.1);
  stroke(MESH_LEFT_BROW_LOWER,  MESH_COLORS.brow,  false, 1.8);
  stroke(MESH_LEFT_BROW_UPPER,  MESH_COLORS.brow,  false, 1.4);
  stroke(MESH_RIGHT_BROW_LOWER, MESH_COLORS.brow,  false, 1.8);
  stroke(MESH_RIGHT_BROW_UPPER, MESH_COLORS.brow,  false, 1.4);
  stroke(MESH_LEFT_EYE,         MESH_COLORS.eye,   true,  1.6);
  stroke(MESH_RIGHT_EYE,        MESH_COLORS.eye,   true,  1.6);
  stroke(MESH_LIPS_OUTER,       MESH_COLORS.lips,  true,  1.6);
  stroke(MESH_LIPS_INNER,       MESH_COLORS.lipsI, true,  1.1);
  stroke(MESH_NOSE_BRIDGE,      MESH_COLORS.nose,  false, 1.4);

  // Iris discs.
  const drawIris = (idxs) => {
    const center = lm[idxs[0]]; if (!center) return;
    const rim    = lm[idxs[1]]; if (!rim) return;
    const r = Math.hypot(px(center) - px(rim), py(center) - py(rim));
    ctx.strokeStyle = MESH_COLORS.iris;
    ctx.lineWidth = 1.4 * dpr;
    ctx.beginPath(); ctx.arc(px(center), py(center), r, 0, Math.PI * 2); ctx.stroke();
  };
  drawIris(MESH_LEFT_IRIS);
  drawIris(MESH_RIGHT_IRIS);

  // Pass 3 — dotted midline.
  ctx.save();
  ctx.setLineDash([4 * dpr, 5 * dpr]);
  ctx.strokeStyle = MESH_COLORS.mid;
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  let started = false;
  for (const i of MESH_FACE_MIDLINE) {
    const p = lm[i]; if (!p) continue;
    const x = px(p), y = py(p);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  if (started) ctx.stroke();
  ctx.restore();
}

// Draws a radial activation glow at each L/R landmark, sized and opacity-scaled by the
// matching blendshape's normalized activation. Rendered on a second canvas layered above
// the base mesh overlay so we don't have to touch SessionMode's drawOverlay.
function drawActivationGlow(canvas, video, lm, bsMap) {
  if (!canvas || !video) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lm || !bsMap) return;
  const t = objectCoverTransform(canvas, video);
  if (!t) return;
  const px = (p) => t.cw - (p.x * t.dw + t.ox); // mirrored X to match scaleX(-1) video
  const py = (p) => p.y * t.dh + t.oy;
  const baseR = Math.min(w, h) * 0.07;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const row of FEATURED_BLENDSHAPES) {
    const drawAt = (idx, value) => {
      const p = lm[idx]; if (!p) return;
      const scaled = Math.min(1, value / row.cap);
      if (scaled < 0.1) return;
      const x = px(p), y = py(p);
      const r = baseR * (0.55 + scaled * 0.85);
      const alpha = Math.round(scaled * 130).toString(16).padStart(2, "0");
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `${row.color}${alpha}`);
      grad.addColorStop(1, `${row.color}00`);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    };
    if (row.single) {
      const value = bsMap[row.single] ?? 0;
      for (const idx of row.glow) drawAt(idx, value);
    } else {
      drawAt(row.glow[0], bsMap[row.left]  ?? 0);
      drawAt(row.glow[1], bsMap[row.right] ?? 0);
    }
  }
  ctx.restore();
}

function TrialMode({ prefs = {} }) {
  const [cameraOn, setCameraOn] = useState(true);
  const [cameraRetryKey, setCameraRetryKey] = useState(0);
  const [showSupportHeader, setShowSupportHeader] = useState(true);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [calibrationStatus, setCalibrationStatus] = useState("Center your face to begin");
  const [calibrated, setCalibrated] = useState(false);
  const [aligned, setAligned] = useState(false);
  const [headPoseDeg, setHeadPoseDeg] = useState(null);
  const [blendshapeMap, setBlendshapeMap] = useState({});
  const [fps, setFps] = useState(null);

  const { stream, cameraError } = useCameraStream(cameraOn, cameraRetryKey);
  const { faceLandmarker, latestRef, status: trackerStatus, trackerError } = useFaceLandmarker(cameraOn, cameraRetryKey);
  const cameraSetupReady = Boolean(cameraOn && stream && !cameraError && trackerStatus === "ready" && faceLandmarker);
  const scoringNoiseMode = normalizeScoringNoiseMode(prefs?.scoringNoiseMode);
  const scoringDiagnosticsEnabled = prefs?.scoringDiagnosticsEnabled === true;

  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const glowRef = useRef(null);

  // Calibration buffers (kept in refs to avoid re-renders during accumulation).
  const calibLmRef = useRef([]);
  const calibBsRef = useRef([]);
  const calibMatrixRef = useRef([]);
  const lastCalibLmRef = useRef(null);
  const lastCalibMatrixRef = useRef(null);
  const neutralRef = useRef(null);
  const noiseRef = useRef(null);
  const neutralBsRef = useRef(null);
  const neutralMatrixRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  const resetCalibration = () => {
    calibLmRef.current = [];
    calibBsRef.current = [];
    calibMatrixRef.current = [];
    lastCalibLmRef.current = null;
    lastCalibMatrixRef.current = null;
    neutralRef.current = null;
    noiseRef.current = null;
    neutralBsRef.current = null;
    neutralMatrixRef.current = null;
    setCalibrated(false);
    setCalibrationProgress(0);
    setCalibrationStatus("Center your face and hold a relaxed neutral pose");
  };

  const retryCameraSetup = () => {
    resetCalibration();
    latestRef.current = null;
    setAligned(false);
    setHeadPoseDeg(null);
    setBlendshapeMap({});
    setFps(null);
    if (!cameraOn) setCameraOn(true);
    setCameraRetryKey((key) => key + 1);
  };

  // Detection + overlay loop. Mirrors SessionMode's pattern but skips phase machinery:
  // we calibrate once, then stream symmetry continuously for whichever exercise is selected.
  useEffect(() => {
    if (!faceLandmarker || !videoRef.current) return undefined;
    let raf = 0;
    let alive = true;
    let lastTs = 0;
    let frameCount = 0;
    let fpsWindowStart = performance.now();

    const tick = async () => {
      if (!alive) return;
      const v = videoRef.current;
      if (!v || v.readyState < 2 || v.paused || v.videoWidth === 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      try {
        const ts = Math.max(lastTs + 1, performance.now());
        lastTs = ts;
        const result = await faceLandmarker.detectForVideo(v, ts);
        if (!alive) return;
        const rawLm = result.faceLandmarks?.[0] ?? null;
        const bsArr = result.faceBlendshapes?.[0]?.categories ?? null;
        const rawMatrix = firstFacialTransformationMatrix(result);

        // FPS readout — simple sliding window over ~1s.
        frameCount++;
        const now = performance.now();
        if (now - fpsWindowStart >= 1000) {
          setFps(Math.round((frameCount * 1000) / (now - fpsWindowStart)));
          frameCount = 0;
          fpsWindowStart = now;
        }

        if (!rawLm) {
          latestRef.current = null;
          setAligned(false);
          setHeadPoseDeg(null);
          drawTrialMesh(overlayRef.current, v, null, false);
          drawActivationGlow(glowRef.current, v, null, null);
          raf = requestAnimationFrame(tick);
          return;
        }

        const prev = latestRef.current;
        const lm = smoothLandmarks(prev?.landmarks, rawLm);
        const facialTransformationMatrix = smoothFacialTransformationMatrix(prev?.facialTransformationMatrix, rawMatrix);
        const bsMap = {};
        if (bsArr) for (const c of bsArr) bsMap[c.categoryName] = c.score;
        latestRef.current = { landmarks: lm, blendshapes: bsMap, facialTransformationMatrix };

        const alignment = faceAlignmentFeedback(lm);
        setAligned(alignment.aligned);
        setBlendshapeMap(bsMap);

        // Head-pose deviation is only meaningful once we have a neutral matrix to
        // compare against; before calibration there's no reference pose.
        if (neutralRef.current) {
          const poseRad = headPoseDeviationRad(facialTransformationMatrix, neutralMatrixRef.current);
          setHeadPoseDeg(poseRad != null ? (poseRad * 180) / Math.PI : null);
        } else {
          setHeadPoseDeg(null);
        }

        // Background calibration accumulator — keeps running until a neutral is captured,
        // so switching from neutral mode to an expression doesn't need a separate calibrate step.
        if (!neutralRef.current) {
          if (alignment.aligned) {
            const delta = lastCalibLmRef.current
              ? normalizedFrameDelta(lm, lastCalibLmRef.current, facialTransformationMatrix, lastCalibMatrixRef.current)
              : 0;
            lastCalibLmRef.current = lm;
            lastCalibMatrixRef.current = facialTransformationMatrix;
            if (delta > CALIBRATION_RESET_EPS) {
              calibLmRef.current = [lm];
              calibBsRef.current = [bsMap];
              calibMatrixRef.current = [facialTransformationMatrix];
              setCalibrationProgress(1);
              setCalibrationStatus(calibrationPrompt(1, delta));
            } else {
              if (calibLmRef.current.length < CALIBRATION_FRAMES) {
                calibLmRef.current.push(lm);
                calibBsRef.current.push(bsMap);
                calibMatrixRef.current.push(facialTransformationMatrix);
              }
              const progress = calibLmRef.current.length;
              setCalibrationProgress(progress);
              setCalibrationStatus(calibrationPrompt(progress, delta));
              if (progress >= CALIBRATION_FRAMES) {
                const neutral = averageLandmarks(calibLmRef.current);
                const neutralMatrix = averageFacialTransformationMatrix(calibMatrixRef.current);
                neutralRef.current = neutral;
                neutralMatrixRef.current = neutralMatrix;
                noiseRef.current = computeNoiseFloor(calibLmRef.current, neutral, calibMatrixRef.current, neutralMatrix);
                neutralBsRef.current = averageBlendshapes(calibBsRef.current);
                setCalibrated(true);
                setCalibrationStatus("Neutral captured. Try an expression on the right.");
              }
            }
          } else {
            calibLmRef.current = [];
            calibBsRef.current = [];
            calibMatrixRef.current = [];
            lastCalibLmRef.current = null;
            lastCalibMatrixRef.current = null;
            setCalibrationProgress(0);
            setCalibrationStatus(alignment.label);
          }
        }

        drawTrialMesh(overlayRef.current, v, lm, alignment.aligned);
        drawActivationGlow(glowRef.current, v, lm, bsMap);
      } catch {
        // Detection is best-effort; transient MediaPipe frame errors should not stop the loop.
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [faceLandmarker, latestRef]);

  const goHome = () => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const calibrationPct = Math.round((calibrationProgress / CALIBRATION_FRAMES) * 100);
  return (
    <div className="min-h-screen w-full" style={{ background: "#F4EFE6", fontFamily: "Manrope, system-ui, sans-serif", color: "#1F1B16" }}>
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full blur-3xl opacity-30" style={{ background: "#D4A574" }} />
        <div className="absolute top-1/2 -left-32 w-80 h-80 rounded-full blur-3xl opacity-20" style={{ background: "#7A8F73" }} />
      </div>

      <div className="relative max-w-7xl mx-auto px-5 lg:px-8 py-6 lg:py-8">
        {showSupportHeader && <DismissibleSupportHeader onDismiss={() => setShowSupportHeader(false)} />}

        <header className="flex items-center justify-between mb-6 lg:mb-8">
          <div className="flex items-center gap-3">
            <button onClick={goHome} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "#1F1B16", color: "#F4EFE6" }} aria-label="Back to app">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-stone-500">Live demo</div>
              <h1 className="text-2xl lg:text-3xl leading-none mt-1" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>
                See your, <em style={{ fontStyle: "italic", fontWeight: 400 }}>facial landmarks</em>.
              </h1>
            </div>
          </div>
          <TrackerBadge status={trackerStatus} fps={fps} scoringNoiseMode={scoringNoiseMode} scoringDiagnosticsEnabled={scoringDiagnosticsEnabled} />
        </header>

        <div className="grid lg:grid-cols-[1.25fr_1fr] gap-5 lg:gap-7">
          {/* LEFT: live camera with landmark overlay */}
          <section className="relative rounded-3xl overflow-hidden" style={{ background: "#1F1B16", color: "#F4EFE6", aspectRatio: "4/3" }}>
            {cameraOn && !cameraError ? (
              <>
                <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
                <canvas ref={glowRef} className="absolute inset-0 w-full h-full pointer-events-none" style={{ mixBlendMode: "screen" }} />
                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
              </>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                {cameraOn && cameraError ? (
                  <CameraSetupStatusPanel
                    cameraEnabled={cameraOn}
                    trackingEnabled={cameraOn}
                    stream={stream}
                    cameraError={cameraError}
                    trackerStatus={trackerStatus}
                    trackerError={trackerError}
                    faceLandmarker={faceLandmarker}
                    onRetry={retryCameraSetup}
                    className="max-w-sm"
                  />
                ) : (
                <div className="opacity-70">
                  <CameraOff className="w-10 h-10 mx-auto mb-3" />
                  <div className="text-sm">{cameraError ?? "Camera off"}</div>
                </div>
                )}
              </div>
            )}

            {cameraOn && !cameraSetupReady && !cameraError && (
              <div className="absolute left-4 right-20 top-4">
                <CameraSetupStatusPanel
                  cameraEnabled={cameraOn}
                  trackingEnabled={cameraOn}
                  stream={stream}
                  cameraError={cameraError}
                  trackerStatus={trackerStatus}
                  trackerError={trackerError}
                  faceLandmarker={faceLandmarker}
                  onRetry={retryCameraSetup}
                />
              </div>
            )}

            {/* Camera toggle */}
            <div className="absolute top-4 right-4">
              <button onClick={() => setCameraOn((on) => !on)} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244,239,230,0.18)", color: "#F4EFE6", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }} aria-label="Toggle camera">
                {cameraOn ? <Camera className="w-4 h-4" /> : <CameraOff className="w-4 h-4" />}
              </button>
            </div>

            {/* Calibration progress / recalibrate footer */}
            <div className="absolute inset-x-0 bottom-0 px-5 py-4" style={{ background: "linear-gradient(to top, rgba(31,27,22,0.92) 0%, rgba(31,27,22,0.6) 60%, transparent 100%)" }}>
              {!calibrated ? (
                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="text-[11px] uppercase tracking-[0.18em] opacity-70">Calibrating neutral</div>
                    <div className="text-xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: "#D4A574" }}>{calibrationPct}%</div>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(244,239,230,0.18)" }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${calibrationPct}%`, background: "#D4A574" }} />
                  </div>
                  <div className="text-xs opacity-80 mt-2">{calibrationStatus}</div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] opacity-60">Ready</div>
                    <div className="text-sm mt-0.5 opacity-90">Try the expression on the right — your symmetry score will appear live.</div>
                  </div>
                  <button onClick={resetCalibration} className="rounded-full px-4 py-2 text-xs font-semibold flex items-center gap-1.5 shrink-0" style={{ background: "rgba(244,239,230,0.15)", color: "#F4EFE6" }}>
                    <RefreshCw className="w-3.5 h-3.5" /> Recalibrate
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* RIGHT: live readouts */}
          <section className="flex flex-col gap-4">
            <BlendshapesPanel bsMap={blendshapeMap} />
            <FacePosturePanel aligned={aligned} headPoseDeg={headPoseDeg} />
          </section>
        </div>

        <footer className="mt-8 text-xs text-stone-500 max-w-3xl">
          <p>
            Built with MediaPipe Face Landmarker — 478 facial landmarks plus 52 ARKit blendshapes, running entirely
            on your device. No video leaves your browser. The neutral baseline above is the same one used during
            full Mirror sessions to score real movement above per-landmark jitter.
          </p>

          <section className="mt-6 rounded-2xl p-5 lg:p-6" style={{ background: "rgba(31,27,22,0.04)", border: "1px solid rgba(31,27,22,0.08)" }}>
            <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500 mb-2">My story</div>
            <p className="text-sm text-stone-700 leading-relaxed">
              Last week, I hit rock bottom. I was diagnosed with Bell's palsy, and my right face got paralysed; I honestly wondered how I was going to get through it. I vibe-coded my way out and built an AI face tracking app that guides my facial exercises, measures facial symmetry in real time, and tracks my progress.
            </p>
            <div className="flex flex-wrap gap-2 mt-4">
              <a href="https://github.com/ialimustufa/mirror-for-Bells-palsy" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
                <GithubGlyph />GitHub
              </a>
              <a href="https://www.linkedin.com/posts/ialimustufa_last-week-i-hit-rock-bottom-i-was-diagnosed-ugcPost-7458136477626093570-PIFK" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "rgba(31,27,22,0.06)", color: "#1F1B16", border: "1px solid rgba(31,27,22,0.08)" }}>
                <LinkedinGlyph />LinkedIn post
              </a>
              <a href="https://x.com/ialimustufa/status/2052044810173993039" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "rgba(31,27,22,0.06)", color: "#1F1B16", border: "1px solid rgba(31,27,22,0.08)" }}>
                <XGlyph />X post
              </a>
            </div>
          </section>

          <MadeByFooter className="mt-4" />
          <SupportedByCard className="mt-4 rounded-2xl p-5 lg:p-6" />
        </footer>
      </div>
    </div>
  );
}

function TrackerBadge({ status, fps, scoringNoiseMode, scoringDiagnosticsEnabled }) {
  let icon, label, color;
  if (status === "loading") { icon = <Loader2 className="w-3.5 h-3.5 animate-spin" />; label = "Loading model"; color = "#D4A574"; }
  else if (status === "error") { icon = <AlertCircle className="w-3.5 h-3.5" />; label = "Tracker unavailable"; color = "#B8543A"; }
  else if (status === "ready") { icon = <div className="w-2 h-2 rounded-full" style={{ background: "#7A8F73", boxShadow: "0 0 8px #7A8F73" }} />; label = fps ? `Tracking · ${fps} fps` : "Tracking"; color = "#7A8F73"; }
  else { icon = <Loader2 className="w-3.5 h-3.5 animate-spin" />; label = "Idle"; color = "#A8A29E"; }
  const title = `Scoring noise mode: ${scoringNoiseMode}${scoringDiagnosticsEnabled ? " · diagnostics on" : ""}`;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold" style={{ background: "rgba(31,27,22,0.06)", color, border: `1px solid ${color}55` }} title={title}>
      {icon}<span>{label}</span>
    </div>
  );
}

function BlendshapesPanel({ bsMap }) {
  // Decaying peak-hold per channel — keeps a tick on each bar showing what the user
  // just reached, even after they relax. Decay multiplier ≈ −5% per frame at 30–60 fps.
  // Also drives the ranking so rows order themselves by recent activation.
  const peaksRef = useRef({});
  const peaks = peaksRef.current;
  for (const row of FEATURED_BLENDSHAPES) {
    if (row.single) {
      const v = bsMap?.[row.single] ?? 0;
      peaks[row.single] = Math.max(v, (peaks[row.single] ?? 0) * 0.95);
    } else {
      const l = bsMap?.[row.left] ?? 0;
      const r = bsMap?.[row.right] ?? 0;
      peaks[row.left]  = Math.max(l, (peaks[row.left]  ?? 0) * 0.95);
      peaks[row.right] = Math.max(r, (peaks[row.right] ?? 0) * 0.95);
    }
  }

  // Rank rows by max scaled peak — the muscle you most recently engaged bubbles to the
  // top, then decays as activity moves elsewhere. Stable sort keeps the original order
  // as the natural tiebreaker when nothing is active yet.
  const ranked = FEATURED_BLENDSHAPES
    .map((row, idx) => ({
      row,
      idx,
      score: row.single
        ? (peaks[row.single] ?? 0) / row.cap
        : Math.max((peaks[row.left] ?? 0) / row.cap, (peaks[row.right] ?? 0) / row.cap),
    }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map((entry) => entry.row);

  const expression = detectExpression(bsMap);

  return (
    <div className="rounded-3xl p-5 lg:p-6" style={{ background: "#FFFFFF", border: "1px solid rgba(31,27,22,0.06)" }}>
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">Active muscles</div>
        <div className="text-[10px] uppercase tracking-wider text-stone-400">blendshape</div>
      </div>

      <div className="flex items-center gap-3 rounded-2xl px-3 py-2 mb-3" style={{ background: expression.strength > 0 ? "rgba(122,143,115,0.12)" : "rgba(31,27,22,0.04)" }}>
        <div className="text-2xl leading-none">{expression.emoji}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-stone-500">We see</div>
          <div className="text-sm font-semibold truncate">{expression.label}</div>
        </div>
        {expression.strength > 0 && (
          <div className="text-[10px] tabular-nums text-stone-500 shrink-0">{Math.round(Math.min(1, expression.strength) * 100)}%</div>
        )}
      </div>

      <div className="space-y-2.5">
        {ranked.slice(0, 6).map((row, rank) => {
          if (row.single) {
            const v = bsMap?.[row.single] ?? 0;
            const peak = peaks[row.single] ?? 0;
            return <BlendshapeRow key={row.label} row={row} rank={rank + 1} single={v} peakSingle={peak} />;
          }
          const l = bsMap?.[row.left] ?? 0;
          const r = bsMap?.[row.right] ?? 0;
          const peakL = peaks[row.left] ?? 0;
          const peakR = peaks[row.right] ?? 0;
          return <BlendshapeRow key={row.label} row={row} rank={rank + 1} left={l} right={r} peakL={peakL} peakR={peakR} />;
        })}
      </div>
    </div>
  );
}

function BlendshapeRow({ row, rank, left, right, peakL, peakR, single, peakSingle }) {
  if (row.single) {
    const scaled = Math.min(1, (single ?? 0) / row.cap);
    const significant = scaled > 0.18;
    const baseColor = significant ? row.color : "#A8A29E";
    return (
      <div className="grid grid-cols-[18px_88px_1fr_1fr] items-center gap-2.5" style={{ transition: "opacity 200ms" }}>
        <div className="text-[10px] tabular-nums text-stone-400 text-right">{rank}</div>
        <div className="text-xs font-semibold text-stone-700">{row.label}</div>
        <div className="col-span-2">
          <ActivationBar scaled={scaled} raw={single ?? 0} peak={Math.min(1, (peakSingle ?? 0) / row.cap)} side="·" color={baseColor} />
        </div>
      </div>
    );
  }
  const scaledL = Math.min(1, left / row.cap);
  const scaledR = Math.min(1, right / row.cap);
  const diff = Math.abs(scaledL - scaledR);
  const significant = Math.max(scaledL, scaledR) > 0.18;
  const asym = diff > 0.22 && significant;
  const baseColor = significant ? (asym ? "#B8543A" : row.color) : "#A8A29E";
  return (
    <div className="grid grid-cols-[18px_88px_1fr_1fr] items-center gap-2.5" style={{ transition: "opacity 200ms" }}>
      <div className="text-[10px] tabular-nums text-stone-400 text-right">{rank}</div>
      <div className="text-xs font-semibold text-stone-700">{row.label}</div>
      <ActivationBar scaled={scaledL} raw={left} peak={Math.min(1, peakL / row.cap)} side="L" color={baseColor} />
      <ActivationBar scaled={scaledR} raw={right} peak={Math.min(1, peakR / row.cap)} side="R" color={baseColor} />
    </div>
  );
}

function ActivationBar({ scaled, raw, peak, side, color }) {
  const frac = Math.min(1, Math.max(0, scaled));
  const peakFrac = Math.min(1, Math.max(0, peak));
  const showPeak = peakFrac > frac + 0.03;
  return (
    <div className="flex items-center gap-2">
      <div className="text-[10px] font-semibold w-3 text-center text-stone-400">{side}</div>
      <div className="relative flex-1 h-2 rounded-full overflow-hidden" style={{ background: "rgba(31,27,22,0.06)" }}>
        <div className="h-full rounded-full transition-all duration-75" style={{ width: `${frac * 100}%`, background: color }} />
        {showPeak && (
          <div className="absolute top-0 bottom-0 w-[2px] rounded-full" style={{ left: `calc(${peakFrac * 100}% - 1px)`, background: "rgba(31,27,22,0.55)" }} />
        )}
      </div>
      <div className="text-[10px] tabular-nums w-8 text-right text-stone-400">{raw.toFixed(2)}</div>
    </div>
  );
}

function FacePosturePanel({ aligned, headPoseDeg }) {
  return (
    <div className="rounded-3xl p-5 lg:p-6" style={{ background: "#FFFFFF", border: "1px solid rgba(31,27,22,0.06)" }}>
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-stone-500">Face position</div>
        <div className="text-[11px] font-semibold" style={{ color: aligned ? "#7A8F73" : "#D4A574" }}>
          {aligned ? "Centered" : "Drifting"}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Posture" value={aligned ? "OK" : "Off"} tone={aligned ? "good" : "warn"} />
        <StatTile label="Head drift" value={headPoseDeg != null ? `${headPoseDeg.toFixed(1)}°` : "—"} tone={headPoseDeg != null && headPoseDeg > 11.5 ? "warn" : "good"} />
      </div>
      <div className="text-[11px] text-stone-500 mt-3 leading-relaxed">
        Hold frames are scored only when your head pose is within ~11° of your captured neutral, so symmetry
        reflects facial movement rather than head turns.
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }) {
  const color = tone === "good" ? "#7A8F73" : tone === "warn" ? "#D4A574" : "#1F1B16";
  return (
    <div className="rounded-2xl p-3" style={{ background: "rgba(31,27,22,0.04)" }}>
      <div className="text-[10px] uppercase tracking-wider text-stone-500">{label}</div>
      <div className="text-2xl tabular-nums mt-1" style={{ fontFamily: "Fraunces", fontWeight: 600, color, letterSpacing: "-0.02em" }}>{value}</div>
    </div>
  );
}

export { TrialMode };
