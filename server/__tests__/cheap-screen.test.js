'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cheapScreen } = require('../saivaree/cheap-screen');
const strong = (patch = {}) => ({ platform: 'tiktok', eligibility: { eligible: true },
  observed_metrics: { recent_weighted_median_views: 5000, view_consistency: 75, viral_dependency: 0.2, sample_size: 20 }, ...patch });

test('strong cached reach and consistency are shortlisted without a score or ranking', () => {
  const row = strong();
  const before = JSON.stringify(row);
  const screen = cheapScreen(row);
  assert.equal(screen.status, 'shortlisted');
  assert.deepEqual(screen.reason_codes, ['cached_reach_consistent', 'multiple_cached_samples']);
  assert.equal(screen.shortlist_rank, null);
  assert.deepEqual(screen.missing_dimensions, []);
  assert.equal(JSON.stringify(row), before);
  assert.deepEqual(cheapScreen(row), screen);
});
test('viral dependency and weak consistency stay on watch even with high reach', () => {
  const screen = cheapScreen(strong({ observed_metrics: { recent_weighted_median_views: 100000, sample_size: 20, view_consistency: 25, viral_dependency: 0.9 } }));
  assert.equal(screen.status, 'watch');
  assert.deepEqual(screen.reason_codes, ['viral_dependency_high', 'consistency_weak']);
});
test('missing and invalid metrics are absent evidence, never zero scores', () => {
  for (const observed_metrics of [{}, { median_views: null, sample_size: '' }, { median_views: ' ', sample_size: false }]) {
    const screen = cheapScreen(strong({ observed_metrics }));
    assert.equal(screen.status, 'insufficient_data');
    assert.ok(screen.missing_dimensions.includes('reach'));
    assert.equal(screen.shortlist_rank, null);
    assert.equal('score' in screen, false);
  }
});
test('clinic and eligibility exclusions take precedence over strong metrics', () => {
  for (const [patch, reason] of [
    [{ clinic_status: 'contacted' }, 'clinic_already_contacted'],
    [{ clinic_status: 'worked_with' }, 'clinic_worked_with'],
    [{ clinic_status: 'not_selected' }, 'clinic_not_selected'],
    [{ clinic_rating: 2 }, 'clinic_rating_low'],
    [{ eligibility: { eligible: false } }, 'ineligible_candidate'],
    [{ eligibility: { classification: 'INELIGIBLE' } }, 'ineligible_candidate'],
    [{ bucket: 'skip' }, 'existing_exclusion'],
  ]) assert.deepEqual(cheapScreen(strong(patch)).reason_codes, [reason]);
  assert.equal(cheapScreen(strong({ clinic_status: 'contacted' })).status, 'excluded');
});
test('Buriram locality alone cannot shortlist or estimate audience or intent', () => {
  const screen = cheapScreen({ platform: 'tiktok', buriram_relevance: 'strong', buriram_signals: [{ code: 'BURIRAM_USERNAME' }] });
  assert.equal(screen.status, 'insufficient_data');
  assert.deepEqual(screen, cheapScreen({ platform: 'tiktok' }));
  assert.doesNotMatch(JSON.stringify(screen), /audience|commercial|potential|score/i);
});
test('median and evidence sample fallbacks work but partial and small samples remain conservative', () => {
  assert.equal(cheapScreen(strong({ observed_metrics: { median_views: 1000, view_consistency: 50, viral_dependency: 0.5 }, evidence_quality: { sample_size: 5 } })).status, 'shortlisted');
  assert.equal(cheapScreen(strong({ observed_metrics: { median_views: 1000, sample_size: 1 } })).status, 'insufficient_data');
  assert.equal(cheapScreen(strong({ observed_metrics: { median_views: 1000, sample_size: 3 } })).status, 'watch');
  assert.equal(cheapScreen(strong({ evidence_quality: { readiness: 'insufficient' } })).status, 'watch');
  assert.equal(cheapScreen(strong({ observed_metrics: { median_views: 0, sample_size: 20, view_consistency: 75, viral_dependency: 0.2 } })).status, 'watch');
});

test('ratio consistency is screening-equivalent to percentage points without mutating metrics', () => {
  for (const [ratio, percent] of [[0.74, 74], [0.69, 69], [0.25, 25], [0, 0], [1, 100]]) {
    const ratioRow = strong();
    const percentRow = strong();
    ratioRow.observed_metrics.view_consistency = ratio;
    percentRow.observed_metrics.view_consistency = percent;
    assert.deepEqual(cheapScreen(ratioRow), cheapScreen(percentRow));
    assert.equal(ratioRow.observed_metrics.view_consistency, ratio);
    assert.equal(percentRow.observed_metrics.view_consistency, percent);
  }
  const row = strong();
  row.observed_metrics.view_consistency = 0.74;
  assert.equal(cheapScreen(row).status, 'shortlisted');
});
test('invalid and missing consistency remain unavailable screening evidence', () => {
  for (const value of [undefined, null, '', ' ', false, -0.1, 101, Infinity, NaN]) {
    const row = strong();
    row.observed_metrics.view_consistency = value;
    const screen = cheapScreen(row);
    assert.equal(screen.status, 'watch');
    assert.ok(screen.missing_dimensions.includes('consistency'));
    assert.ok(!screen.available_dimensions.includes('consistency'));
    assert.ok(!screen.reason_codes.includes('consistency_weak'));
    assert.equal(row.observed_metrics.view_consistency, value);
  }
});
