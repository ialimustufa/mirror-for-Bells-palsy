import { COMFORT_DOSING } from "../domain/config";
import { summarizeAssessmentSession } from "../domain/assessment";
import { clinicalScaleInputCompletenessSummaries, clinicalScaleInputGapSummaries, clinicalScaleMovementLabels, clinicalScaleRestingEvidenceSummary } from "../domain/clinicalScales";
import { clinicalScalePresentationPolicy, scaleNounForClinicalScale } from "../domain/clinicalScalePresentation";
import { summarizeSessionDiagnostics } from "../domain/sessionDiagnostics";
import { addDaysISO, formatCalendarDate, formatClock, recordDateISO, todayISO } from "../domain/session";
import { baselineProgressLabel, movementBalanceLabel, movementProgressLabel, progressUsesLegacySideConvention } from "../ml/faceMetrics";
import { displayPct, scoreColor } from "../ui/scoreFormatting";

function formatSessionDate(s) {
  const today = todayISO();
  const yISO = addDaysISO(today, -1);
  const date = recordDateISO(s);
  const time = s.ts ? formatClock(new Date(s.ts)) : "";
  if (date === today) return `Today${time ? ` · ${time}` : ""}`;
  if (date === yISO) return `Yesterday${time ? ` · ${time}` : ""}`;
  const d = formatCalendarDate(date ?? s.date, { month: "short", day: "numeric" });
  return `${d}${time ? ` · ${time}` : ""}`;
}

function formatDuration(secs) {
  if (!secs) return "—";
  const m = Math.floor(secs / 60), r = secs % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatRatioPct(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "n/a";
}

function omittedClinicalScaleMovementLabels(clinicalScales) {
  const ids = clinicalScales?.evidence?.omittedMovementExerciseIds ?? clinicalScales?.coverage?.unusableExerciseIds ?? [];
  return clinicalScaleMovementLabels(ids);
}

function formatRestMetricValue(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function restingMetricSidePhrase(metric) {
  const entries = [
    ["narrowerSide", "narrower"],
    ["smallerSide", "smaller"],
    ["lowerSide", "lower"],
    ["higherSide", "higher"],
  ];
  for (const [key, label] of entries) {
    const side = metric?.[key];
    if (!side || side === "balanced") continue;
    return `${label} ${side}`;
  }
  return "balanced";
}

function restingMetricRows(restingMetrics) {
  const metrics = restingMetrics?.metrics;
  if (!metrics || typeof metrics !== "object") return [];
  return ["palpebralFissure", "nasolabialMidface", "oralCommissure"]
    .map((key) => metrics[key])
    .filter(Boolean)
    .map((metric) => `${metric.label}: L ${formatRestMetricValue(metric.userLeft)}, R ${formatRestMetricValue(metric.userRight)} · ${restingMetricSidePhrase(metric)} · asym ${formatRatioPct(metric.asymmetryRatio)}`);
}

function clinicalScaleEstimateRows(clinicalScales, presentation = clinicalScalePresentationPolicy()) {
  if (!clinicalScales) return [];
  if (clinicalScales.status !== "estimated") {
    return [`Scale-inspired estimates unavailable: ${(clinicalScales.reasons ?? ["insufficient data"]).join("; ")}.`];
  }
  const scales = clinicalScales.scales ?? {};
  const omittedMovements = omittedClinicalScaleMovementLabels(clinicalScales);
  const inputGaps = clinicalScaleInputGapSummaries(clinicalScales);
  const inputCompletenessSummaries = clinicalScaleInputCompletenessSummaries(clinicalScales);
  const restingEvidence = clinicalScaleRestingEvidenceSummary(clinicalScales);
  return [
    scales.houseBrackmann ? `House-Brackmann-inspired ${scaleNounForClinicalScale(presentation, "houseBrackmann")}: Grade ${scales.houseBrackmann.grade} (${scales.houseBrackmann.label})` : null,
    scales.sunnybrook ? `Sunnybrook-style ${scaleNounForClinicalScale(presentation, "sunnybrook")}: ${Math.round(scales.sunnybrook.compositeScore)}/100 composite (${scales.sunnybrook.voluntaryMovementScore} voluntary - ${scales.sunnybrook.restingSymmetryScore} rest - ${scales.sunnybrook.synkinesisScore} synkinesis)` : null,
    scales.eface ? `eFACE-style ${scaleNounForClinicalScale(presentation, "eface")}: ${Math.round(scales.eface.totalScore)}/100 total (${Math.round(scales.eface.staticScore)} static, ${Math.round(scales.eface.dynamicScore)} dynamic, ${Math.round(scales.eface.synkinesisScore)} synkinesis)` : null,
    ...inputGaps.map((gap) => gap.message),
    ...inputCompletenessSummaries.map((summary) => summary.message),
    `Evidence standard: ${clinicalScales.coverage?.usableMovementCount ?? 0}/${clinicalScales.coverage?.requiredMovementCount ?? 0} standard movements usable (${formatRatioPct(clinicalScales.coverage?.ratio)}).`,
    restingEvidence ? `Resting evidence: ${restingEvidence.availableCount}/${restingEvidence.requiredCount} required resting metrics available${restingEvidence.complete ? "" : `; missing ${restingEvidence.missingMetricLabels.join(", ")}`}.` : null,
    omittedMovements.length
      ? `Omitted from scale formulas: ${omittedMovements.join(", ")}.`
      : null,
    clinicalScales.evidence?.label ? `Evidence tier: ${clinicalScales.evidence.label}.` : null,
  ].filter(Boolean);
}

function usableProgress(progress) {
  return progressUsesLegacySideConvention(progress) ? null : progress;
}

function buildSessionReportHtml(s, options = {}) {
  const includeClinicalScaleEstimates = options.includeClinicalScaleEstimates !== false;
  const ts = s.ts ? new Date(s.ts) : new Date();
  const dateStr = ts.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = formatClock(ts);
  const dur = formatDuration(s.duration);
  const overallPct = displayPct(s.sessionAvg);
  const overallColor = scoreColor(s.sessionAvg);
  const comfort = s.comfortLevel ? (COMFORT_DOSING[s.comfortLevel]?.label ?? s.comfortLevel) : null;
  const sessionType = s.kind === "assessment" ? "Standard assessment" : s.kind === "practice" ? "Practice run" : "Daily session";
  const baseline = usableProgress(s.baselineProgress);
  const initialBaseline = usableProgress(s.initialBaselineProgress);
  const movement = usableProgress(s.movementProgress);
  const initialMovement = usableProgress(s.initialMovementProgress);
  const scoresArr = s.scores || [];
  const totalReps = scoresArr.reduce((sum, e) => sum + (e.scores?.length ?? 0), 0);
  const diagnostics = summarizeSessionDiagnostics(s);
  const assessment = s.kind === "assessment" ? summarizeAssessmentSession(s) : null;
  const clinicalScalePolicy = clinicalScalePresentationPolicy();
  const restingRows = restingMetricRows(assessment?.resting?.metrics);
  const clinicalScaleRows = includeClinicalScaleEstimates ? clinicalScaleEstimateRows(assessment?.clinicalScales, clinicalScalePolicy) : [];
  const quality = diagnostics.captureQuality;
  const diagnosticFlags = [
    diagnostics.setupQuality ? `Setup quality: ${diagnostics.setupQuality.label ?? diagnostics.setupQuality.key}${diagnostics.setupQuality.score != null ? ` (${Math.round(diagnostics.setupQuality.score * 100)}%)` : ""}` : null,
    quality ? `Capture quality: ${quality.label ?? quality.key} (${formatRatioPct(quality.validFrameRatio)} valid frames, ${quality.rejectedFrameCount ?? 0} rejected)` : null,
    diagnostics.topDropReasons.length ? `Top rejected frames: ${diagnostics.topDropReasons.map((item) => `${item.label} x${item.count}`).join(", ")}` : null,
    diagnostics.coactivation && diagnostics.coactivation.risk !== "low" ? `Quiet-region movement: ${diagnostics.coactivation.risk}` : null,
  ].filter(Boolean);
  const diagnosticsBlock = diagnostics.hasDiagnostics ? `
    <section class="diagnostics">
      <h2>Data Quality And Safety Notes</h2>
      ${diagnostics.scoringModelVersion ? `<div class="muted small">Scoring model version ${escapeHtml(diagnostics.scoringModelVersion)}</div>` : ""}
      ${diagnostics.captureQualityNote ? `<p>${escapeHtml(diagnostics.captureQualityNote)}</p>` : ""}
      ${diagnosticFlags.length ? `<ul>${diagnosticFlags.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      ${diagnostics.safetyPrompts.length ? `<div class="safety">${diagnostics.safetyPrompts.map((item) => `<div>${escapeHtml(item)}</div>`).join("")}</div>` : ""}
    </section>` : "";
  const assessmentBlock = assessment ? `
    <section class="assessment">
      <h2>Standard Assessment Sections</h2>
      <div class="assessment-grid">
        <div>
          <div class="assessment-label">Rest</div>
          <div class="muted small">${assessment.resting.baselineSnapshotAvailable ? "Neutral calibration image captured for review." : "Neutral calibration was used for scoring; no review image is attached."}</div>
          ${restingRows.length ? `<ul class="resting-metrics">${restingRows.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<div class="muted small">Resting asymmetry metrics were not available for this assessment.</div>`}
        </div>
        <div>
          <div class="assessment-label">Voluntary movement</div>
          <div class="muted small">${assessment.averageVoluntaryMovement == null ? "No aggregate voluntary movement score." : `${Math.round(assessment.averageVoluntaryMovement * 100)}% average across assessment zones.`}</div>
        </div>
        <div>
          <div class="assessment-label">Coactivation</div>
          <div class="muted small">${assessment.coactivationRisk ? `Quiet-region movement risk: ${escapeHtml(assessment.coactivationRisk)}.` : "No elevated quiet-region movement recorded."}</div>
        </div>
      </div>
      <div class="zone-list">
        ${assessment.zones.map((zone) => `<div><strong>${escapeHtml(zone.label)}</strong>: ${zone.voluntaryMovement == null ? "unscored" : `${Math.round(zone.voluntaryMovement * 100)}%`}${zone.coactivationRisk ? ` · quiet movement ${escapeHtml(zone.coactivationRisk)}` : ""}</div>`).join("")}
      </div>
      ${clinicalScaleRows.length ? `<div class="clinical-scales"><div class="assessment-label">${escapeHtml(clinicalScalePolicy.reportHeading)}</div><ul>${clinicalScaleRows.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><div class="muted small">${escapeHtml(clinicalScalePolicy.reportNotice)}</div></div>` : ""}
    </section>` : "";

  const exerciseRows = scoresArr.map((e, scoreIndex) => {
    const scoreDiagnostics = diagnostics.exercises[scoreIndex];
    const pct = displayPct(e.avg);
    const color = scoreColor(e.avg);
    const repsArr = e.scores ?? [];
    const repLabel = `${repsArr.length}${e.repsTarget ? `/${e.repsTarget}` : ""} rep${(e.repsTarget ?? repsArr.length) === 1 ? "" : "s"}`;
    const doseBits = [
      e.region,
      repLabel,
      e.holdSec ? `${e.holdSec}s hold` : null,
      e.restSec ? `${e.restSec}s rest` : null,
    ].filter(Boolean).join(" · ");
    const repBreakdown = repsArr.length > 0
      ? repsArr.map((r) => {
          const rp = displayPct(r);
          return `<span class="rep" style="background:${rp == null ? "#E7E5E4" : scoreColor(r)};color:#fff">${rp == null ? "—" : rp + "%"}</span>`;
        }).join("")
      : '<span class="muted">No symmetry data captured</span>';
    const exerciseMovement = usableProgress(e.movementProgress);
    const exerciseInitialMovement = usableProgress(e.initialMovementProgress);
    const exerciseBaseline = usableProgress(e.baselineProgress);
    const exerciseInitialBaseline = usableProgress(e.initialBaselineProgress);
    const baselineLine = exerciseMovement
      ? `<div class="muted small">Current baseline: affected side · ${escapeHtml(movementProgressLabel(exerciseMovement) ?? "")}</div>`
      : exerciseBaseline
      ? `<div class="muted small">Current baseline: ${escapeHtml(exerciseBaseline.side)} side · ${escapeHtml(baselineProgressLabel(exerciseBaseline) ?? "")}</div>`
      : "";
    const initialBalanceLine = exerciseInitialMovement && movementBalanceLabel(exerciseInitialMovement)
      ? `<div class="muted small">${escapeHtml(movementBalanceLabel(exerciseInitialMovement))}</div>`
      : "";
    const initialBaselineLine = exerciseInitialMovement
      ? `<div class="muted small">First baseline: affected side · ${escapeHtml(movementProgressLabel(exerciseInitialMovement) ?? "")}</div>${initialBalanceLine}`
      : exerciseInitialBaseline
      ? `<div class="muted small">First baseline: ${escapeHtml(exerciseInitialBaseline.side)} side · ${escapeHtml(baselineProgressLabel(exerciseInitialBaseline) ?? "")}</div>`
      : "";
    const qualityLine = scoreDiagnostics?.captureQuality
      ? `<div class="muted small">Data quality: ${escapeHtml(scoreDiagnostics.captureQuality.label ?? scoreDiagnostics.captureQuality.key)} · ${escapeHtml(formatRatioPct(scoreDiagnostics.captureQuality.validFrameRatio))} valid frames</div>`
      : "";
    const coactivationLine = scoreDiagnostics?.coactivation && scoreDiagnostics.coactivation.risk !== "low"
      ? `<div class="muted small">Quiet-region movement: ${escapeHtml(scoreDiagnostics.coactivation.risk)}</div>`
      : "";
    const dropLine = scoreDiagnostics?.topDropReasons?.length
      ? `<div class="muted small">Rejected frames: ${escapeHtml(scoreDiagnostics.topDropReasons.map((item) => `${item.label} x${item.count}`).join(", "))}</div>`
      : "";
    const allSnapshots = e.snapshots || [];
    const movementSnap = allSnapshots.reduce((best, snap) => {
      if (!best) return snap;
      return (snap.score ?? -1) > (best.score ?? -1) ? snap : best;
    }, null);
    const baselineImage = e.baselineSnapshot || s.baselineSnapshot || null;
    const movementPct = displayPct(movementSnap?.score);
    const comparison = baselineImage || movementSnap ? `
      <div class="comparison">
        <figure class="compare-frame">
          ${baselineImage ? `<img src="${baselineImage}" alt="Neutral baseline frame" />` : `<div class="missing-image">No baseline image</div>`}
          <figcaption>Baseline neutral</figcaption>
        </figure>
        <figure class="compare-frame">
          ${movementSnap ? `<img src="${movementSnap.dataUrl}" alt="Peak movement frame" />` : `<div class="missing-image">No movement image</div>`}
          <figcaption>Movement${movementPct == null ? "" : ` · ${movementPct}%`}</figcaption>
        </figure>
      </div>`
      : "";
    const snapshots = allSnapshots.slice(0, 6).map((snap) => {
      const sp = displayPct(snap.score);
      return `<div class="snap"><img src="${snap.dataUrl}" alt="" /><div class="snap-label" style="background:${scoreColor(snap.score)}">${sp == null ? "—" : sp + "%"}</div></div>`;
    }).join("");
    return `
      <section class="exercise">
        <div class="ex-head">
          <div>
            <div class="ex-name">${escapeHtml(e.name)}</div>
            <div class="muted small">${escapeHtml(doseBits)}</div>
            ${baselineLine}
            ${initialBaselineLine}
            ${qualityLine}
            ${coactivationLine}
            ${dropLine}
          </div>
          <div class="ex-score" style="color:${color}">${pct == null ? "—" : pct + "%"}</div>
        </div>
        <div class="reps">${repBreakdown}</div>
        ${comparison}
        ${snapshots ? `<div class="snaps">${snapshots}</div>` : ""}
      </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Facial Retraining Session — ${escapeHtml(dateStr)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1F1B16; margin: 0; padding: 32px; background: #F4EFE6; }
  .page { max-width: 760px; margin: 0 auto; background: #fff; padding: 40px 44px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #78716C; margin: 28px 0 12px; font-weight: 600; }
  .meta { color: #57534E; font-size: 13px; margin-bottom: 24px; }
  .summary { display: grid; grid-template-columns: auto 1fr; gap: 24px; align-items: center; padding: 20px; background: #FAF7F0; border-radius: 12px; margin-bottom: 12px; }
  .big-score { font-size: 56px; font-weight: 700; line-height: 1; letter-spacing: -0.02em; color: ${overallColor}; }
  .summary-meta { font-size: 13px; color: #57534E; line-height: 1.6; }
  .summary-meta strong { color: #1F1B16; }
  .baseline { padding: 12px 16px; background: rgba(122,143,115,0.12); border-radius: 8px; font-size: 13px; color: #4A6B47; margin-bottom: 12px; }
  .diagnostics { padding: 14px 16px; background: #FAF7F0; border: 1px solid #E7E5E4; border-radius: 10px; margin: 16px 0; font-size: 13px; color: #57534E; }
  .diagnostics h2 { margin-top: 0; }
  .diagnostics p { margin: 8px 0; }
  .diagnostics ul { margin: 8px 0 0; padding-left: 18px; }
  .diagnostics li { margin: 3px 0; }
  .safety { margin-top: 10px; padding-top: 10px; border-top: 1px solid #E7E5E4; color: #8F3C2A; line-height: 1.5; }
  .assessment { padding: 14px 16px; background: rgba(122,143,115,0.1); border: 1px solid rgba(122,143,115,0.24); border-radius: 10px; margin: 16px 0; font-size: 13px; color: #4A6B47; }
  .assessment h2 { margin-top: 0; color: #4A6B47; }
  .assessment-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 8px; }
  .assessment-label { font-weight: 700; color: #1F1B16; margin-bottom: 2px; }
  .resting-metrics { margin: 8px 0 0 0; padding-left: 16px; color: #4A6B47; }
  .zone-list { margin-top: 12px; line-height: 1.6; }
  .clinical-scales { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(122,143,115,0.22); }
  .clinical-scales ul { margin: 6px 0 0; padding-left: 16px; color: #4A6B47; }
  .exercise { padding: 16px 0; border-top: 1px solid #E7E5E4; }
  .exercise:first-of-type { border-top: none; }
  .ex-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .ex-name { font-weight: 600; font-size: 15px; margin-bottom: 2px; }
  .ex-score { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .reps { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
  .rep { font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
  .compare-frame { margin: 0; border: 1px solid #E7E5E4; border-radius: 10px; overflow: hidden; background: #FAF7F0; }
  .compare-frame img { width: 100%; height: 220px; object-fit: cover; object-position: center; display: block; image-rendering: auto; }
  .compare-frame figcaption { font-size: 11px; color: #57534E; padding: 7px 9px; background: #FAF7F0; font-weight: 600; }
  .missing-image { height: 220px; display: flex; align-items: center; justify-content: center; color: #A8A29E; font-size: 12px; background: #F5F2EC; }
  .snaps { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .snap { position: relative; width: 72px; height: 104px; border-radius: 6px; overflow: hidden; border: 1px solid #E7E5E4; }
  .snap img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .snap-label { position: absolute; bottom: 0; inset-inline: 0; font-size: 9px; color: #fff; text-align: center; padding: 1px 0; font-weight: 600; }
  .muted { color: #78716C; }
  .small { font-size: 12px; margin-top: 2px; }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #E7E5E4; font-size: 11px; color: #78716C; line-height: 1.6; }
  @media print {
    body { background: #fff; padding: 0; }
    .page { box-shadow: none; border-radius: 0; padding: 24px; max-width: none; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
  <div class="page">
    <h1>Facial Retraining Session Report</h1>
    <div class="meta">${escapeHtml(dateStr)}${timeStr ? ` · ${escapeHtml(timeStr)}` : ""}</div>

    <div class="summary">
      <div class="big-score">${overallPct == null ? "—" : overallPct + "%"}</div>
      <div class="summary-meta">
        <div><strong>Average symmetry</strong> across the session</div>
        <div>Type: <strong>${escapeHtml(sessionType)}</strong></div>
        <div>Duration: <strong>${escapeHtml(dur)}</strong></div>
        <div>Exercises: <strong>${scoresArr.length}</strong> · Reps captured: <strong>${totalReps}</strong></div>
        ${comfort ? `<div>Comfort level: <strong>${escapeHtml(comfort)}</strong></div>` : ""}
      </div>
    </div>

    ${movement ? `<div class="baseline"><strong>Current baseline progress:</strong> affected side · ${escapeHtml(movementProgressLabel(movement) ?? "")}</div>` : baseline ? `<div class="baseline"><strong>Current baseline progress:</strong> ${escapeHtml(baseline.side)} side · ${escapeHtml(baselineProgressLabel(baseline) ?? "")}</div>` : ""}
    ${initialMovement ? `<div class="baseline"><strong>Affected side:</strong> ${escapeHtml((movementProgressLabel(initialMovement) ?? "").replace("from baseline", "from first baseline"))}${movementBalanceLabel(initialMovement) ? `<br /><strong>Affected vs proper side:</strong> ${escapeHtml(movementBalanceLabel(initialMovement).replace(/^affected vs proper: /, ""))}` : ""}</div>` : initialBaseline ? `<div class="baseline"><strong>First baseline progress:</strong> ${escapeHtml(initialBaseline.side)} side · ${escapeHtml(baselineProgressLabel(initialBaseline) ?? "")}</div>` : ""}
    ${assessmentBlock}
    ${diagnosticsBlock}

    <h2>By Exercise</h2>
    ${exerciseRows || '<div class="muted">No exercises recorded.</div>'}

    <div class="footer">
      Symmetry is auto-detected from facial landmarks captured during the session. Some movement variation is normal even in healthy faces.
      Generated for clinical review by a physiotherapist or facial retraining specialist. ${escapeHtml(clinicalScalePolicy.footerNotice)}
    </div>
  </div>
  <script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 250); });</script>
</body>
</html>`;
}

function shareSessionReport(sessionLike, options = {}) {
  const html = buildSessionReportHtml(sessionLike, options);
  const win = window.open("", "_blank");
  if (!win) {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mirror-session-report-${sessionLike.date || todayISO()}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}
export { buildSessionReportHtml, clinicalScaleEstimateRows, formatDuration, formatSessionDate, shareSessionReport };
