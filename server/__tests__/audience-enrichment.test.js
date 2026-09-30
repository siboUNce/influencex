'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPS, analyzeAudienceEvidence, aggregateCommercialIntent, planToken,
  createAudienceEnrichment, cacheKey,
} = require('../saivaree/audience-enrichment');

const REF = '11111111-1111-4111-8111-111111111111';
const row = (patch = {}) => ({ creator_id: REF, username: 'creator_one', platform: 'tiktok',
  eligibility: { eligible: true }, observed_metrics: { recent_weighted_median_views: 5000,
    view_consistency: 75, viral_dependency: .2, sample_size: 20 }, ...patch });
const comment = (patch = {}) => ({ author_handle: '@person', body: '',
  public_author_locality: '', public_author_bio: '', source_url: 'https://www.tiktok.com/@creator_one/video/1', ...patch });
const quotaOk = { status: () => ({ runLimit: 100, runs: 0, itemsLimit: 1000, items: 0,
  workspace: { runLimit: 100, runs: 0, itemsLimit: 1000, items: 0 } }), record() {} };
const db = { query: async () => ({ rows: [] }) };
const cache = { put: async () => {} };
const harness = (rows, opts = {}) => {
  const calls = { apify: 0, harvest: 0, cachedWrites: [] };
  const service = createAudienceEnrichment({ db: opts.db || db, getRows: async () => rows, quota: opts.quota || quotaOk,
    apify: { runActor: async () => { calls.apify++; return { success: true, runId: 'post-run', items: [
      { webVideoUrl: 'https://www.tiktok.com/@creator_one/video/1' },
      { webVideoUrl: 'https://www.tiktok.com/@creator_one/video/2' },
      { webVideoUrl: 'https://www.tiktok.com/@creator_one/video/3' },
      { webVideoUrl: 'https://www.tiktok.com/@creator_one/video/4' },
    ] }; } },
    harvest: async ({ videoUrls, limitPerVideo, ...rest }) => { calls.harvest++; assert.ok(videoUrls.length <= 3); assert.equal(limitPerVideo, 30); if (opts.harvest) return opts.harvest({ videoUrls, limitPerVideo, ...rest }); if (opts.harvestResult) return opts.harvestResult; return { success: true, comments: videoUrls.flatMap(u => Array.from({ length: 40 }, (_, i) => comment({ source_url: u, author_handle: '@person' + i, body: 'RAW_COMMENT_SENTINEL ราคาเท่าไหร่', public_author_locality: 'Buriram' }))), runs: [{ actor_id: 'comments', run_id: 'comments-run', success: true }] }; },
    cache: { put: async (...args) => { calls.cachedWrites.push(args[3]); } }, now: () => 1700000000000, tokenKey: Buffer.alloc(32, 7),
  });
  return { service, calls };
};
const err = async (promise, status) => { await assert.rejects(promise, e => e.status === status); };

test('public locality is stronger than contextual mention', () => {
  const direct = analyzeAudienceEvidence([comment({ author_handle: '@a', public_author_locality: 'บุรีรัมย์' })], 1);
  const contextual = analyzeAudienceEvidence([comment({ author_handle: '@a', body: 'I am from Buriram' })], 1);
  assert.ok(['moderate', 'weak'].includes(direct.level));
  assert.equal(contextual.level, 'weak');
  assert.ok(direct.direct_profile_local_count > contextual.direct_profile_local_count);
});
test('no evidence is insufficient and makes no residence or follower claim', () => {
  const result = analyzeAudienceEvidence([], 0);
  assert.equal(result.level, 'insufficient');
  assert.doesNotMatch(JSON.stringify(result), /follower|residen|percentage|wealth|purchasing/i);
});
test('Thai and English commercial intent patterns aggregate into categories', () => {
  const result = aggregateCommercialIntent([
    { body: 'ราคาเท่าไหร่คะ' }, { body: 'ขอจองนัดได้ไหม' }, { body: 'พิกัดคลินิกอยู่ที่ไหน' },
    { body: 'What is the price and where is the clinic?' }, { body: 'interested in booking' },
  ]);
  assert.equal(result.intent_comment_count, 5);
  assert.ok(result.category_counts.price >= 2 && result.category_counts.booking >= 2);
  assert.ok(result.category_counts.location >= 2 && result.category_counts.service_interest >= 2);
  assert.doesNotMatch(JSON.stringify(result), /wealth|purchasing_power|ability_to_pay/i);
});
test('plan is provider free and exposes bounded caps for shortlisted TikTok', async () => {
  const { service, calls } = harness([row()]);
  const result = await service.plan('ws-a', { creator_ref: REF });
  assert.deepEqual({ max_posts: result.max_posts, comments_per_post: result.comments_per_post,
    max_provider_runs: result.max_provider_runs, max_comment_items: result.max_comment_items }, CAPS);
  assert.equal(calls.apify, 0); assert.equal(calls.harvest, 0); assert.match(result.plan_token, /^[a-f0-9]{64}$/);
});
test('plan rejects non TikTok and non shortlisted rows without providers', async () => {
  for (const patch of [{ platform: 'youtube' }, { observed_metrics: {} }, { observed_metrics: { recent_weighted_median_views: 1, view_consistency: 20, viral_dependency: .9, sample_size: 20 } }]) {
    const { service, calls } = harness([row(patch)]); await err(service.plan('ws-a', { creator_ref: REF }), 409); assert.equal(calls.apify + calls.harvest, 0);
  }
});
test('forged and stale plans reject before provider calls', async () => {
  const { service, calls } = harness([row()]);
  await err(service.execute('ws-a', { creator_ref: REF, plan_token: '0'.repeat(64), request_id: 'r1' }), 409);
  assert.equal(calls.apify + calls.harvest, 0);
});
test('quota preflight rejects whole bounded operation before first provider', async () => {
  const quota = { status: () => ({ runLimit: 3, runs: 0, itemsLimit: 100, items: 0 }), record() {} };
  const { service, calls } = harness([row()], { quota });
  const plan = await service.plan('ws-a', { creator_ref: REF });
  await err(service.execute('ws-a', { creator_ref: REF, plan_token: plan.plan_token, request_id: 'r2' }), 429);
  assert.equal(calls.apify + calls.harvest, 0);
});
test('fixture execution is bounded to three posts and caches normalized evidence', async () => {
  const { service, calls } = harness([row()]);
  service.execute = service.execute.bind(service);
  const plan = await service.plan('ws-a', { creator_ref: REF });
  // Cache read remains empty in this isolated fixture; verify provider calls and bounded harvest semantics.
  const result = await service.execute('ws-a', { creator_ref: REF, plan_token: plan.plan_token, request_id: 'r3' });
  assert.equal(calls.apify, 1); assert.equal(calls.harvest, 1); assert.equal(result.cached, false);
  assert.equal(result.provider_runs.length, 2);
  assert.ok(result.provider_runs.length <= 4);
  assert.equal(result.audience_enrichment.buriram_audience.posts_sampled, 3);
  assert.ok(result.audience_enrichment.buriram_audience.posts_sampled <= 3);
  for (const aggregate of [result.audience_enrichment.buriram_audience, result.audience_enrichment.commercial_intent]) {
    assert.equal(aggregate.sample_count, 90);
    assert.ok(aggregate.sample_count <= 90);
  }
  assert.equal(calls.cachedWrites.length, 1);
  assert.deepEqual(calls.cachedWrites[0], result.audience_enrichment);
  for (const aggregate of [result, calls.cachedWrites[0]]) {
    assert.doesNotMatch(JSON.stringify(aggregate), /"comments"\s*:|RAW_COMMENT_SENTINEL|follower_percentage|residence|wealth|purchasing_power/i);
  }
});
test('plan token binds workspace and creator identity', () => {
  const a = planToken('a', row(), 1700000000000, Buffer.alloc(32, 1));
  const b = planToken('b', row(), 1700000000000, Buffer.alloc(32, 1));
  assert.notEqual(a, b); assert.notEqual(cacheKey('a', row()), cacheKey('b', row()));
});

test('fresh cached execute skips every provider', async () => {
  const data = { version: 1, expires_at: new Date(1700000000000 + 86400000).toISOString(),
    buriram_audience: analyzeAudienceEvidence([], 0), commercial_intent: aggregateCommercialIntent([]), evidence_lines: [] };
  const cachedDb = { query: async () => ({ rows: [{ username: cacheKey('ws-a', row()),
    profile_data: JSON.stringify(data), expires_at: data.expires_at }] }) };
  const { service, calls } = harness([row()], { db: cachedDb });
  const plan = await service.plan('ws-a', { creator_ref: REF });
  assert.equal(plan.cache_state, 'fresh');
  const result = await service.execute('ws-a', { creator_ref: REF, plan_token: plan.plan_token, request_id: 'cached' });
  assert.equal(result.cached, true);
  assert.deepEqual(result.provider_runs, []);
  assert.deepEqual(result.audience_enrichment, data);
  assert.equal(calls.apify, 0); assert.equal(calls.harvest, 0);
  assert.equal(calls.cachedWrites.length, 0);
});

test('execute rechecks shortlist after a successful plan', async () => {
  const rows = [row()];
  const { service, calls } = harness(rows);
  const plan = await service.plan('ws-a', { creator_ref: REF });
  rows[0] = row({ observed_metrics: {} });
  await err(service.execute('ws-a', { creator_ref: REF, plan_token: plan.plan_token, request_id: 'changed' }), 409);
  assert.equal(calls.apify, 0); assert.equal(calls.harvest, 0);
});

test('plan and execute strictly reject unknown and missing request fields', async () => {
  const { service, calls } = harness([row()]);
  for (const body of [{}, { creator_ref: REF, unknown: true }, { unknown: REF }]) {
    await err(service.plan('ws-a', body), 400);
  }
  const valid = { creator_ref: REF, plan_token: '0'.repeat(64), request_id: 'validation' };
  for (const key of Object.keys(valid)) {
    const body = { ...valid }; delete body[key];
    await err(service.execute('ws-a', body), 400);
  }
  await err(service.execute('ws-a', { ...valid, unknown: true }), 400);
  await err(service.execute('ws-a', { creator_ref: REF, plan_token: valid.plan_token, unknown: true }), 400);
  assert.equal(calls.apify, 0); assert.equal(calls.harvest, 0);
});

test('partial harvest caches aggregate evidence with actual post coverage and reduced confidence', async () => {
  const urls = [1, 2].map(i => 'https://www.tiktok.com/@creator_one/video/' + i);
  const harvestResult = { success: true, partial: true, posts_sampled: 2, successful_post_count: 2, failed_post_count: 1,
    comments: urls.flatMap(source_url => Array.from({ length: 30 }, (_, i) => comment({ source_url,
      author_handle: '@person' + i, body: 'RAW_COMMENT_SENTINEL ราคาเท่าไหร่', public_author_locality: 'Buriram' }))),
    runs: [
      { actor_id: 'comments', run_id: 'success-1', success: true },
      { actor_id: 'comments', run_id: 'success-2', success: true },
      { actor_id: 'comments', run_id: 'failed-3', success: false },
    ] };
  const { service, calls } = harness([row()], { harvest: async ({ videoUrls, strict }) => {
    assert.deepEqual(videoUrls, [...urls, 'https://www.tiktok.com/@creator_one/video/3']);
    assert.equal(strict, true);
    return harvestResult;
  } });
  const plan = await service.plan('ws-a', { creator_ref: REF });
  const result = await service.execute('ws-a', { creator_ref: REF, plan_token: plan.plan_token, request_id: 'partial' });
  assert.equal(result.cached, false);
  assert.equal(calls.apify, 1);
  assert.equal(calls.harvest, 1);
  assert.deepEqual(result.audience_enrichment.coverage, { status: 'partial', requested_posts: 3, posts_sampled: 2, failed_post_count: 1 });
  assert.equal(result.audience_enrichment.buriram_audience.posts_sampled, 2);
  assert.equal(result.provider_runs.length, 4);
  assert.equal(result.provider_runs[3].success, false);
  assert.equal(result.provider_runs[3].run_id, 'failed-3');
  assert.equal(calls.cachedWrites.length, 1);
  assert.deepEqual(calls.cachedWrites[0], result.audience_enrichment);
  assert.doesNotMatch(JSON.stringify(calls.cachedWrites[0]), /"comments"\s*:|RAW_COMMENT_SENTINEL/);
  for (const aggregate of [result.audience_enrichment.buriram_audience, result.audience_enrichment.commercial_intent]) {
    assert.equal(aggregate.sample_count, 60);
    assert.ok(aggregate.reason_codes.includes('partial_post_coverage'));
    assert.equal(aggregate.confidence, 'medium');
  }
});

test('zero usable evidence after provider failure rejects without a cache write', async () => {
  const { service, calls } = harness([row()], { harvestResult: { success: false, code: 'comment_provider_failed',
    comments: [], runs: [{ actor_id: 'comments', run_id: 'failed-1', success: false }] } });
  const plan = await service.plan('ws-a', { creator_ref: REF });
  await assert.rejects(service.execute('ws-a', { creator_ref: REF, plan_token: plan.plan_token, request_id: 'failed' }),
    e => e.status === 502 && e.code === 'comment_provider_failed');
  assert.equal(calls.apify, 1);
  assert.equal(calls.harvest, 1);
  assert.equal(calls.cachedWrites.length, 0);
});
