#!/usr/bin/env node
// Dry-run backfill: recompute session averages from stored frame samples under the current
// (fixed) scorer, for sessions inside a recent window. WRITES NOTHING — it prints what would
// change so you can eyeball the deltas before any write-back path is enabled.
//
// Usage:
//   npm run backfill:rescore -- <backup.jsonl|export.json> [--days 5] [--since YYYY-MM-DD] [--tolerance 0.02] [--json]
import { readFile } from "node:fs/promises";
import {
  extractFrameSamplesFromExportPayload,
  extractSessionsFromExportPayload,
  rescoreSessionsFromFrameSamples,
} from "../src/ml/frameSampleReplay.js";

function parseArgs(argv) {
  const args = { days: 5, tolerance: 0.02, json: false, since: null, path: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") args.days = Number(argv[++i]);
    else if (arg === "--since") args.since = argv[++i];
    else if (arg === "--tolerance") args.tolerance = Number(argv[++i]);
    else if (arg === "--json") args.json = true;
    else if (!arg.startsWith("--") && !args.path) args.path = arg;
  }
  return args;
}

async function readPayload(path) {
  const text = await readFile(path, "utf8");
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine?.startsWith("{") && firstLine.includes('"kind":"mirror-browser-data-lines"')) {
    const stores = { sessions: [], sessionFrameSamples: [] };
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (item.store === "sessions") stores.sessions.push(item.record);
      else if (item.store === "sessionFrameSamples" || item.store === "frameSamples") stores.sessionFrameSamples.push(item.record);
    }
    return { stores };
  }
  return JSON.parse(text);
}

const args = parseArgs(process.argv.slice(2));
if (!args.path) {
  console.error("Usage: npm run backfill:rescore -- <backup.jsonl|export.json> [--days 5] [--since YYYY-MM-DD] [--tolerance 0.02] [--json]");
  process.exit(1);
}

const sinceTs = args.since
  ? new Date(`${args.since}T00:00:00`).getTime()
  : Date.now() - args.days * 24 * 60 * 60 * 1000;

const payload = await readPayload(args.path);
const frameSamples = extractFrameSamplesFromExportPayload(payload);
const sessions = extractSessionsFromExportPayload(payload);
const report = rescoreSessionsFromFrameSamples({ frameSamples, sessions, sinceTs, scoreTolerance: args.tolerance });

if (args.json) {
  console.log(JSON.stringify({ sinceTs, ...report }, null, 2));
} else {
  const windowLabel = args.since ? `since ${args.since}` : `last ${args.days} days`;
  console.log(`Backfill dry-run (${windowLabel}) — DRY RUN, nothing written\n`);
  console.log(`Frame samples: ${frameSamples.length} | hold frames replayed: ${report.replayStats.holdFrameCount} | replay agreement: ${report.replayStats.scoredAgreementRatio} | stored sessions in window: ${report.sessionCount}`);
  console.log(`Verdicts: ${Object.entries(report.summary).map(([k, v]) => `${k}=${v}`).join("  ")}\n`);
  for (const s of report.sessions) {
    const date = s.date ?? (s.ts ? new Date(s.ts).toISOString().slice(0, 10) : "?");
    const arrow = s.sessionAvgDelta != null
      ? `${(s.storedSessionAvg * 100).toFixed(1)}% -> ${(s.newSessionAvg * 100).toFixed(1)}% (${s.sessionAvgDelta >= 0 ? "+" : ""}${(s.sessionAvgDelta * 100).toFixed(1)}pt)`
      : s.storedSessionAvg != null ? `${(s.storedSessionAvg * 100).toFixed(1)}% (unchanged)` : "n/a";
    const check = s.selfCheckPassed === true ? `selfcheck ok (max ${s.maxControlDelta})`
      : s.selfCheckPassed === false ? `SELFCHECK FAIL (max ${s.maxControlDelta})`
      : "selfcheck: no control";
    console.log(`${date}  [${s.verdict}]  ${arrow}  ${check}`);
    for (const ex of s.changedExercises) {
      console.log(`    ${ex.exerciseId}: ${ex.storedAvg} -> ${ex.replayAvg} (${ex.delta >= 0 ? "+" : ""}${ex.delta})`);
    }
  }
  console.log(`\nNothing was written. Inspect the deltas above; the write-back path is gated behind a separate confirmation.`);
}
