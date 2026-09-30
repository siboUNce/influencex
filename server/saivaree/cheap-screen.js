'use strict';

// Cached review triage only: no audience geography, commercial intent, or /100 score.
function numberOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cheapScreen(row = {}) {
  const metrics = row.observed_metrics || {};
  const evidence = row.evidence_quality || {};
  const reach = numberOrNull(metrics.recent_weighted_median_views) ?? numberOrNull(metrics.median_views);
  const rawConsistency = numberOrNull(metrics.view_consistency);
  // Cached sources use either a ratio or percentage points; normalize only for screening.
  const consistency = rawConsistency !== null && rawConsistency <= 1 ? rawConsistency * 100 : rawConsistency;
  const viral = numberOrNull(metrics.viral_dependency);
  const sample = numberOrNull(metrics.sample_size) ?? numberOrNull(evidence.sample_size);
  const dimensions = {
    reach: reach !== null,
    consistency: consistency !== null && consistency <= 100,
    viral_dependency: viral !== null && viral <= 1,
    sample_size: sample !== null && Number.isInteger(sample),
  };
  const result = (status, reason_codes) => ({
    version: 1, status, reason_codes, shortlist_rank: null,
    available_dimensions: Object.keys(dimensions).filter(key => dimensions[key]),
    missing_dimensions: Object.keys(dimensions).filter(key => !dimensions[key]),
  });
  const rating = numberOrNull(row.clinic_rating);
  if (['contacted', 'worked_with', 'not_selected'].includes(row.clinic_status)) {
    return result('excluded', [row.clinic_status === 'contacted' ? 'clinic_already_contacted' : 'clinic_' + row.clinic_status]);
  }
  if (rating !== null && rating <= 2) return result('excluded', ['clinic_rating_low']);
  const eligibility = row.eligibility || {};
  if ((eligibility.classification && eligibility.classification !== 'ELIGIBLE_INFLUENCER') || eligibility.eligible === false) {
    return result('excluded', ['ineligible_candidate']);
  }
  if (['skip', 'already_contacted'].includes(row.bucket)) return result('excluded', ['existing_exclusion']);
  if (String(row.platform || '').toLowerCase() !== 'tiktok') return result('insufficient_data', ['unsupported_platform']);
  if (!dimensions.reach || !dimensions.sample_size || sample < 2) return result('insufficient_data', ['insufficient_cached_evidence']);
  // Broad review gates, not a performance score: consistency is 0-100; viral share is 0-1.
  // Five samples avoid single-hit shortlists. Positive median reach avoids arbitrary audience-size cutoffs.
  if (!dimensions.consistency || !dimensions.viral_dependency) {
    return result(reach > 0 ? 'watch' : 'insufficient_data', ['partial_cached_evidence']);
  }
  const risks = [];
  if (viral > 0.5) risks.push('viral_dependency_high');
  if (consistency < 50) risks.push('consistency_weak');
  if (risks.length) return result('watch', risks);
  if (sample < 5 || evidence.readiness === 'insufficient' || reach === 0) return result('watch', ['limited_cached_evidence']);
  return result('shortlisted', ['cached_reach_consistent', 'multiple_cached_samples']);
}

module.exports = { cheapScreen };
