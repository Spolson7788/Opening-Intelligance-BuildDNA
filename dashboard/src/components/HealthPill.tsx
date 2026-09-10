export function healthBand(score: number | null): "good" | "fair" | "poor" | "unknown" {
  if (score === null || score === undefined) return "unknown";
  if (score >= 75) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

export function HealthPill({ score }: { score: number | null }) {
  const band = healthBand(score);
  const label = score === null || score === undefined ? "No data" : Math.round(score).toString();
  return <span className={`health-pill health-${band}`}>{label}</span>;
}
