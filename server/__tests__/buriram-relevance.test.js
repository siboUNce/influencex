const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyBuriramRelevance } = require('../saivaree/buriram-relevance');
const { createSaivareeHandlers } = require('../saivaree/intelligence-routes');

const evidence = (...refs) => ({ discovery_provenance: [{ local_evidence_refs: refs }] });
for (const [name, candidate, relevance, score, sources] of [
  ['username', { username: 'creator_BuRiRaM' }, 'strong', 100, ['username']],
  ['display name', { display_name: 'รีวิวบุรีรัมย์' }, 'strong', 90, ['display_name']],
  ['bio', evidence('bio:บุรีรัมย์'), 'strong', 80, ['bio']],
  ['caption', evidence('caption:บุรีรัมย์'), 'related', 45, ['caption']],
  ['hashtag', evidence('hashtag:บุรีรัมย์'), 'related', 35, ['hashtag']],
  ['caption plus hashtag', evidence('caption:บุรีรัมย์', 'hashtag:บุรีรัมย์'), 'strong', 80, ['caption', 'hashtag']],
  ['query only', { discovery_provenance: [{ query: 'beauty BURIRAM' }, { query: 'บุรีรัมย์' }] }, 'related', 20, ['discovery_query']],
  ['generic Thai beauty', { username: 'beauty_thai', display_name: 'สาวไทย บิวตี้', ...evidence('bio:กรุงเทพ', 'caption:ความงาม') }, 'none', 0, []],
]) {
  test('Buriram relevance: ' + name, () => {
    const actual = classifyBuriramRelevance(candidate);
    assert.equal(actual.buriram_relevance, relevance);
    assert.equal(actual.buriram_score, score);
    assert.deepEqual(actual.buriram_signals.map(signal => signal.source), sources);
    for (const signal of actual.buriram_signals) {
      assert.equal(signal.code, 'BURIRAM_' + signal.source.toUpperCase());
      assert.ok(signal.snippet.length <= 80);
    }
  });
}

test('Buriram refs are deduplicated across provenance and capped at two per source', () => {
  const refs = ['bio', 'caption', 'hashtag'].flatMap(source => [source + ':บุรีรัมย์', source + ':buriram', source + ':BURIRAM']);
  const candidate = { username: 'buriram', display_name: 'Buriram', discovery_provenance: [
    { query: 'Buriram', local_evidence_refs: refs.concat(refs) },
    { query: 'บุรีรัมย์', local_evidence_refs: refs },
  ] };
  const original = structuredClone(candidate);
  const actual = classifyBuriramRelevance(candidate);
  assert.equal(actual.buriram_score, 100 + 90 + 160 + 90 + 70 + 20);
  assert.equal(actual.buriram_signals.length, 9);
  assert.deepEqual(candidate, original);
  assert.equal(classifyBuriramRelevance(evidence('caption:บุรีรัมย์', 'caption:บุรีรัมย์')).buriram_score, 45);
});

test('Buriram matching is exact, ignores untrusted signal types, and handles missing values', () => {
  for (const candidate of [undefined, null, {}, { discovery_provenance: {} },
    { username: 'notburiram', display_name: 'burirams buriram2 buri ram บุรีรัม' },
    { bio: 'บุรีรัมย์', discovery_provenance: [{ normalized_signals: ['บุรีรัมย์'], local_evidence_refs: ['location:บุรีรัมย์', 'caption:burirams', null, {}] }, null] },
  ]) assert.deepEqual(classifyBuriramRelevance(candidate), { buriram_relevance: 'none', buriram_score: 0, buriram_signals: [] });
});

test('Buriram evidence snippets are bounded', () => {
  const actual = classifyBuriramRelevance({ display_name: 'Buriram ' + 'x'.repeat(100), ...evidence('bio:บุรีรัมย์ ' + 'x'.repeat(100)) });
  assert.deepEqual(actual.buriram_signals.map(signal => signal.snippet.length), [80, 80]);
});

test('mapped discovery and recommendations include relevance without changing order, ranks or buckets', async () => {
  const candidates = [
    { creator_id: 'related', username: 'related', candidate_tier: 'discovery_only', selection_rank: 2, ...evidence('caption:บุรีรัมย์') },
    { creator_id: 'strong', username: 'buriram', candidate_tier: 'discovery_only', selection_rank: 3 },
    { creator_id: 'none', username: 'generic', candidate_tier: 'decision_grade', selection_rank: 1 },
  ].map(candidate => ({ platform: 'tiktok', eligibility: { classification: 'ELIGIBLE_INFLUENCER' }, ...candidate }));
  const makeRes = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const db = { query: async () => ({ rows: [] }) };
  const handlers = createSaivareeHandlers({ db, analyzer: {
    getCreatorDiscovery: async () => ({ candidates }), getPromisingStars: async () => ({ candidates }),
  } });
  const control = createSaivareeHandlers({ db, analyzer: { getCreatorDiscovery: async () => ({ candidates: candidates.map(candidate => ({ ...candidate, username: candidate.creator_id, discovery_provenance: [] })) }) } });
  const baseline = makeRes();
  await control.getCreatorDiscovery({ workspace: { id: 'test' } }, baseline);
  for (const handler of [handlers.getCreatorDiscovery, handlers.getContactRecommendations]) {
    const res = makeRes();
    await handler({ workspace: { id: 'test' } }, res);
    assert.equal(res.statusCode, 200);
    const ordering = rows => rows.map(({ creator_id, bucket, rank }) => ({ creator_id, bucket, rank }));
    assert.deepEqual(ordering(res.body.creators), ordering(baseline.body.creators));
    assert.deepEqual(res.body.creators.map(row => row.creator_id), ['none', 'related', 'strong']);
    assert.deepEqual(res.body.creators.map(row => row.buriram_relevance), ['none', 'related', 'strong']);
    assert.deepEqual(res.body.creators.map(row => row.buriram_score), [0, 45, 100]);
    for (const row of res.body.creators) assert.ok(Array.isArray(row.buriram_signals));
    assert.deepEqual(res.body.summary, baseline.body.summary);
  }
});
