/**
 * V1 Health Score — deliberately simple and explainable.
 * Do NOT replace this with a black-box model until there's enough
 * service/inspection history to validate predictions against outcomes.
 *
 * Score: 0 (critical) - 100 (excellent)
 */

export interface HealthScoreInputs {
  installDate: Date | null;
  lastServiceDate: Date | null;
  serviceEventsLast12Months: number;
  failedInspectionsLast24Months: number;
  openComplianceIssues: number;
  fireRated: boolean;
}

export interface HealthScoreResult {
  score: number;
  factors: Record<string, number>;
}

const YEARS = (ms: number) => ms / (1000 * 60 * 60 * 24 * 365.25);

export function computeHealthScore(inputs: HealthScoreInputs): HealthScoreResult {
  const now = new Date();
  const factors: Record<string, number> = {};

  // Start from a perfect score and subtract.
  let score = 100;

  // Age penalty: openings/hardware degrade over time. Cap the penalty at 25 points.
  if (inputs.installDate) {
    const ageYears = YEARS(now.getTime() - inputs.installDate.getTime());
    const agePenalty = Math.min(25, ageYears * 1.5);
    factors.age_penalty = -agePenalty;
    score -= agePenalty;
  } else {
    // Unknown install date is itself a data-quality problem worth penalizing lightly.
    factors.unknown_install_date_penalty = -5;
    score -= 5;
  }

  // Service recency: openings not serviced in a long time are a risk signal.
  if (inputs.lastServiceDate) {
    const yearsSinceService = YEARS(now.getTime() - inputs.lastServiceDate.getTime());
    const recencyPenalty = Math.min(20, Math.max(0, (yearsSinceService - 1) * 8));
    factors.service_recency_penalty = -recencyPenalty;
    score -= recencyPenalty;
  } else {
    factors.never_serviced_penalty = -15;
    score -= 15;
  }

  // High service frequency in the last year suggests a chronic problem, not stability.
  if (inputs.serviceEventsLast12Months >= 3) {
    const freqPenalty = Math.min(20, (inputs.serviceEventsLast12Months - 2) * 7);
    factors.high_service_frequency_penalty = -freqPenalty;
    score -= freqPenalty;
  }

  // Failed inspections are a strong negative signal.
  if (inputs.failedInspectionsLast24Months > 0) {
    const inspectionPenalty = Math.min(25, inputs.failedInspectionsLast24Months * 12);
    factors.failed_inspection_penalty = -inspectionPenalty;
    score -= inspectionPenalty;
  }

  // Open compliance issues on a fire-rated/life-safety opening are weighted heavier.
  if (inputs.openComplianceIssues > 0) {
    const multiplier = inputs.fireRated ? 15 : 8;
    const compliancePenalty = Math.min(30, inputs.openComplianceIssues * multiplier);
    factors.open_compliance_penalty = -compliancePenalty;
    score -= compliancePenalty;
  }

  score = Math.max(0, Math.min(100, Math.round(score * 100) / 100));

  return { score, factors };
}
