export function displayPct(raw) {
  if (raw == null) return null;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
}

export function scoreColor(v) {
  if (v == null) return "#A8A29E";
  if (v >= 0.8) return "#7A8F73";
  if (v >= 0.6) return "#D4A574";
  return "#B8543A";
}

// Color for a recovery ratio (affected-side movement vs the frozen baseline, where 1.0 means
// "same as baseline"). Unlike scoreColor, the neutral point is 1.0: at/above baseline is the
// healthy direction (green), around baseline is amber, clearly below is red. Used by the
// recovery heatmap so a good movement day isn't painted red just because the instantaneous
// left/right symmetry ratio dipped.
export function recoveryColor(ratio) {
  if (ratio == null) return "#A8A29E";
  if (ratio >= 1.15) return "#7A8F73";
  if (ratio >= 0.85) return "#D4A574";
  return "#B8543A";
}
