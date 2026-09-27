const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DB = path.join(
  os.tmpdir(),
  `influencex-saivaree-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`
);

process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DATABASE_URL = '';

const database = require('../database');
const { initializeDatabase, query, queryOne, exec } = database;
const { runPendingMigrations } = require('../migrations');
const {
  getSaivareeMeta,
  upsertSaivareeMeta,
  evaluateCampaignFit,
  classifyContactRecommendation,
  compareContactRecommendations,
  createSaivareeHandlers,
  registerSaivareeIntelligenceRoutes,
} = require('../saivaree/intelligence-routes');
const { createAnalyzerClient } = require('../saivaree/analyzer-client');
const {
  normalizeMigrationRecord,
  planMigration,
  applyMigration,
  parseArgs,
} = require('../../scripts/migrate-saivaree-creators');

before(async () => {
  await initializeDatabase();
  await runPendingMigrations({ query, queryOne, exec });
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch {}
  }
});

test('saivaree_kol_meta migration creates constrained sidecar table idempotently', async () => {
  const second = await runPendingMigrations({ query, queryOne, exec });
  assert.equal(second.applied, 0);

  const table = await queryOne(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ['saivaree_kol_meta']
  );
  assert.ok(table?.sql, 'sidecar table must exist');
  for (const column of [
    'workspace_id',
    'kol_database_id',
    'platform',
    'username',
    'saivaree_creator_id',
    'clinic_status',
    'clinic_rating',
    'clinic_notes',
    'created_at',
    'updated_at',
  ]) {
    assert.match(table.sql, new RegExp('\\b' + column + '\\b', 'i'));
  }
  assert.match(table.sql, /UNIQUE\s*\(workspace_id,\s*kol_database_id\)/i);
  assert.match(table.sql, /clinic_rating\s+IS\s+NULL/i);

  await exec(
    `INSERT INTO saivaree_kol_meta
       (workspace_id, kol_database_id, platform, username, clinic_status, clinic_rating)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['ws-a', 'kol-a', 'tiktok', 'creator.a', 'contacted', 5]
  );

  await assert.rejects(
    exec(
      `INSERT INTO saivaree_kol_meta
         (workspace_id, kol_database_id, platform, username, clinic_status)
       VALUES (?, ?, ?, ?, ?)`,
      ['ws-a', 'kol-b', 'tiktok', 'creator.b', 'invalid-status']
    ),
    /CHECK constraint failed/i
  );

  await assert.rejects(
    exec(
      `INSERT INTO saivaree_kol_meta
         (workspace_id, kol_database_id, platform, username, clinic_rating)
       VALUES (?, ?, ?, ?, ?)`,
      ['ws-a', 'kol-c', 'tiktok', 'creator.c', 6]
    ),
    /CHECK constraint failed/i
  );

  await assert.rejects(
    exec(
      `INSERT INTO saivaree_kol_meta
         (workspace_id, kol_database_id, platform, username)
       VALUES (?, ?, ?, ?)`,
      ['ws-a', 'kol-a', 'tiktok', 'creator.a']
    ),
    /UNIQUE constraint failed/i
  );
});

test('saivaree metadata helpers isolate workspace and kol id', async () => {
  const dbApi = { queryOne, exec };

  await upsertSaivareeMeta(dbApi, 'ws-a', 'shared-kol', {
    platform: 'tiktok',
    username: 'creator.same',
    clinic_status: 'worked_with',
    clinic_rating: 5,
    clinic_notes: 'A only',
  });
  await upsertSaivareeMeta(dbApi, 'ws-b', 'shared-kol', {
    platform: 'tiktok',
    username: 'creator.same',
    clinic_status: 'watching',
    clinic_rating: 2,
    clinic_notes: 'B only',
  });

  const a = await getSaivareeMeta(dbApi, 'ws-a', 'shared-kol');
  const b = await getSaivareeMeta(dbApi, 'ws-b', 'shared-kol');

  assert.equal(a.clinic_status, 'worked_with');
  assert.equal(a.clinic_rating, 5);
  assert.equal(a.clinic_notes, 'A only');
  assert.equal(b.clinic_status, 'watching');
  assert.equal(b.clinic_rating, 2);
  assert.equal(b.clinic_notes, 'B only');
});

function fakeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('analyzer client sends internal key and returns cached analysis', async () => {
  const calls = [];
  const client = createAnalyzerClient({
    baseUrl: 'http://analyzer.test',
    apiKey: 'test-key-with-at-least-32-bytes',
    timeoutMs: 50,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse(200, {
        creator_id: 'creator-1',
        analysis_status: 'available',
        observed_metrics: { median_views: 12000 },
      });
    },
  });

  const result = await client.getAnalysis('creator-1');

  assert.equal(result.analysis_status, 'available');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].options.headers['X-InfluenceX-Internal-Key'],
    'test-key-with-at-least-32-bytes'
  );
  assert.match(calls[0].url, /\/internal\/influencex\/creators\/creator-1\/analysis$/);
});

test('analyzer client maps missing analysis without starting analysis', async () => {
  let analyzeCalls = 0;
  const client = createAnalyzerClient({
    baseUrl: 'http://analyzer.test',
    apiKey: 'test-key-with-at-least-32-bytes',
    fetchImpl: async (url) => {
      if (url.endsWith('/analysis')) return fakeResponse(404, { detail: 'analysis not found' });
      if (url.endsWith('/analyze')) analyzeCalls += 1;
      return fakeResponse(500, { detail: 'unexpected' });
    },
  });

  const result = await client.getAnalysis('creator-1');

  assert.deepEqual(result, { analysis_status: 'missing' });
  assert.equal(analyzeCalls, 0);
});

test('analyzer client maps timeout to analyzer_unavailable', async () => {
  const client = createAnalyzerClient({
    baseUrl: 'http://analyzer.test',
    apiKey: 'test-key-with-at-least-32-bytes',
    timeoutMs: 10,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  await assert.rejects(
    client.getAnalysis('creator-1'),
    (error) => error && error.code === 'analyzer_unavailable'
  );
});

test('cached analysis handler scopes KOL lookup and never calls analyze', async () => {
  const sqlCalls = [];
  const fakeDb = {
    async queryOne(sql, params) {
      sqlCalls.push({ sql, params });
      if (/FROM kol_database/i.test(sql)) {
        return { id: 'kol-1', workspace_id: 'ws-a', platform: 'tiktok', username: 'creator.a' };
      }
      if (/FROM saivaree_kol_meta/i.test(sql)) {
        return {
          workspace_id: 'ws-a',
          kol_database_id: 'kol-1',
          platform: 'tiktok',
          username: 'creator.a',
          saivaree_creator_id: 'creator-1',
          clinic_status: 'watching',
          clinic_rating: null,
          clinic_notes: null,
        };
      }
      return null;
    },
    async exec() {},
  };
  let analyzeCalls = 0;
  const analyzer = {
    async getAnalysis(id) {
      assert.equal(id, 'creator-1');
      return { creator_id: id, analysis_status: 'available', observed_metrics: { median_views: 10000 } };
    },
    async resolveCreator() { throw new Error('resolve should not run for mapped creator'); },
    async analyze() { analyzeCalls += 1; },
  };
  const handlers = createSaivareeHandlers({
    db: fakeDb,
    analyzer,
    randomUUID: () => 'uuid-1',
  });
  const req = { workspace: { id: 'ws-a' }, params: { kolId: 'kol-1' } };
  const res = makeRes();

  await handlers.getAnalysis(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.analysis_status, 'available');
  assert.equal(analyzeCalls, 0);
  assert.match(sqlCalls[0].sql, /workspace_id\s*=\s*\?/i);
  assert.deepEqual(sqlCalls[0].params, ['kol-1', 'ws-a']);
});

test('unknown platform is treated as missing and never calls Analyzer', async () => {
  let storedMeta = null;
  const fakeDb = {
    async queryOne(sql, params) {
      if (/FROM kol_database/i.test(sql)) {
        return { id: 'kol-u', workspace_id: params[1], platform: 'unknown', username: 'babyben_dd' };
      }
      if (/FROM saivaree_kol_meta/i.test(sql)) return storedMeta;
      return null;
    },
    async exec(sql, params) {
      if (/INSERT INTO saivaree_kol_meta/i.test(sql)) {
        storedMeta = {
          workspace_id: params[0],
          kol_database_id: params[1],
          platform: params[2],
          username: params[3],
          saivaree_creator_id: params[4],
          clinic_status: params[5],
          clinic_rating: params[6],
          clinic_notes: params[7],
        };
      }
    },
  };
  let resolveCalls = 0;
  let analyzeCalls = 0;
  const analyzer = {
    async resolveCreator() { resolveCalls += 1; return { creator_id: null }; },
    async getAnalysis() { throw new Error('getAnalysis should not run'); },
    async analyze() { analyzeCalls += 1; },
  };
  const handlers = createSaivareeHandlers({ db: fakeDb, analyzer, randomUUID: () => 'uuid-1' });

  const readRes = makeRes();
  await handlers.getAnalysis({ workspace: { id: 'ws-a' }, params: { kolId: 'kol-u' } }, readRes);
  assert.equal(readRes.statusCode, 200);
  assert.equal(readRes.body.analysis_status, 'missing');
  assert.equal(resolveCalls, 0);

  const analyzeRes = makeRes();
  await handlers.analyze({ workspace: { id: 'ws-a' }, params: { kolId: 'kol-u' } }, analyzeRes);
  assert.equal(analyzeRes.statusCode, 400);
  assert.equal(analyzeRes.body.code, 'platform_required');
  assert.equal(analyzeCalls, 0);
});

test('compare handler reads cached analysis only', async () => {
  const fakeDb = {
    async queryOne(sql, params) {
      if (/FROM kol_database/i.test(sql)) {
        return {
          id: params[0],
          workspace_id: params[1],
          platform: 'tiktok',
          username: params[0] === 'kol-a' ? 'creator.a' : 'creator.b',
        };
      }
      if (/FROM saivaree_kol_meta/i.test(sql)) {
        return {
          workspace_id: params[0],
          kol_database_id: params[1],
          platform: 'tiktok',
          username: params[1] === 'kol-a' ? 'creator.a' : 'creator.b',
          saivaree_creator_id: params[1] === 'kol-a' ? 'creator-a' : 'creator-b',
          clinic_status: 'watching',
          clinic_rating: null,
          clinic_notes: null,
        };
      }
      return null;
    },
    async exec() {},
  };
  let analyzeCalls = 0;
  const analyzer = {
    async getAnalysis(id) {
      return { creator_id: id, analysis_status: 'available', observed_metrics: { median_views: 1000 } };
    },
    async resolveCreator() { return { creator_id: null }; },
    async analyze() { analyzeCalls += 1; },
  };
  const handlers = createSaivareeHandlers({
    db: fakeDb,
    analyzer,
    randomUUID: () => 'uuid-1',
  });
  const req = {
    workspace: { id: 'ws-a' },
    body: { kol_ids: ['kol-a', 'kol-b'] },
  };
  const res = makeRes();

  await handlers.compare(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.creators.length, 2);
  assert.equal(analyzeCalls, 0);
});


function recommendationFixture({
  clinic_status = 'watching',
  clinic_rating = null,
  ai_score = 60,
  email = 'creator@example.com',
  readiness = 'decision_grade',
  decision_ready = true,
  analysis_status = 'available',
  username = 'creator',
  recent = 1000,
  consistency = 70,
  viral = 0.2,
  fit = 'strong',
} = {}) {
  const kol = {
    id: 'kol-' + username,
    platform: 'tiktok',
    username,
    email,
    ai_score,
  };
  const meta = { clinic_status, clinic_rating };
  const analysis = {
    analysis_status,
    observed_metrics: {
      recent_weighted_median_views: recent,
      view_consistency: consistency,
      viral_dependency: viral,
      sample_size: readiness === 'decision_grade' ? 20 : readiness === 'directional' ? 15 : 5,
    },
    evidence_quality: { readiness, decision_ready },
  };
  return { kol, meta, analysis, campaignFit: { level: fit } };
}

test('campaign fit is deterministic from campaign targeting and creator profile signals', () => {
  assert.equal(evaluateCampaignFit({ campaign: { id: 'camp-a' }, kol: { source_campaign_id: 'camp-a' } }).level, 'strong');

  const categoryFit = evaluateCampaignFit({
    campaign: { id: 'camp-a', filter_criteria: JSON.stringify({ categories: 'skincare, hifu' }) },
    kol: { category: 'Skincare' },
  });
  assert.equal(categoryFit.level, 'strong');
  assert.ok(categoryFit.matched_terms.includes('skincare'));

  const partialFit = evaluateCampaignFit({
    campaign: { id: 'camp-a', name: 'Ulthera Lifting', description: '' },
    kol: { bio: 'Beauty creator focused on lifting routines' },
  });
  assert.equal(partialFit.level, 'partial');
  assert.deepEqual(partialFit.matched_terms, ['lifting']);

  assert.equal(evaluateCampaignFit({
    campaign: { id: 'camp-a', filter_criteria: { categories: 'skincare' } },
    kol: { bio: 'Food and travel creator' },
  }).level, 'none');
  assert.equal(evaluateCampaignFit({
    campaign: { id: 'camp-a', name: 'Clinic Campaign' },
    kol: { bio: 'Anything' },
  }).level, 'unknown');
  assert.equal(evaluateCampaignFit({
    campaign: { id: 'camp-a', filter_criteria: { categories: 'hifu' } },
    kol: { tags: '[\"beauty\",\"hifu\"]' },
  }).level, 'strong');
  assert.equal(evaluateCampaignFit({
    campaign: { id: 'camp-a', filter_criteria: { categories: 'hifu' } },
    kol: { tags: 'beauty hifu skincare' },
  }).level, 'strong');
});

test('same creator can be contact for one campaign and skip for another', () => {
  const kol = { id: 'kol-same', platform: 'tiktok', username: 'same.creator', email: 'same@example.com', category: 'skincare' };
  const analysis = {
    analysis_status: 'available',
    observed_metrics: { sample_size: 24 },
    evidence_quality: { readiness: 'decision_grade', decision_ready: true },
  };
  const meta = { clinic_status: 'watching', clinic_rating: 5 };
  const fitA = evaluateCampaignFit({ campaign: { id: 'camp-a', filter_criteria: { categories: 'skincare' } }, kol });
  const fitB = evaluateCampaignFit({ campaign: { id: 'camp-b', filter_criteria: { categories: 'food' } }, kol });
  assert.equal(classifyContactRecommendation({ kol, meta, analysis, campaignFit: fitA }).bucket, 'contact');
  assert.equal(classifyContactRecommendation({ kol, meta, analysis, campaignFit: fitB }).bucket, 'skip');
});

test('ai_score cannot change contact classification or ordering', () => {
  const low = recommendationFixture({ ai_score: 0, username: 'zulu', recent: 5000 });
  const high = recommendationFixture({ ai_score: 99, username: 'alpha', recent: 1000 });
  assert.equal(classifyContactRecommendation(low).bucket, 'contact');
  assert.equal(classifyContactRecommendation(high).bucket, 'contact');
  const baseRows = [
    { username: 'zulu', bucket: 'contact', ai_score: 0, campaign_fit: { level: 'strong' }, observed_metrics: { recent_weighted_median_views: 5000 } },
    { username: 'alpha', bucket: 'contact', ai_score: 99, campaign_fit: { level: 'strong' }, observed_metrics: { recent_weighted_median_views: 1000 } },
  ];
  const first = baseRows.map(row => ({ ...row })).sort(compareContactRecommendations).map(row => row.username);
  const swapped = baseRows.map(row => ({ ...row, ai_score: row.ai_score === 0 ? 99 : 0 })).sort(compareContactRecommendations).map(row => row.username);
  assert.deepEqual(first, ['zulu', 'alpha']);
  assert.deepEqual(swapped, first);
});

test('contact sorter uses objective Creator Intelligence signals in the declared order', () => {
  const strong = { bucket: 'contact', campaign_fit: { level: 'strong' }, clinic_status: 'watching' };
  const rows = [
    { ...strong, username: 'recent-low', observed_metrics: { recent_weighted_median_views: 100 } },
    { ...strong, username: 'recent-high', observed_metrics: { recent_weighted_median_views: 200 } },
    { ...strong, username: 'consistency-low', observed_metrics: { recent_weighted_median_views: 50, view_consistency: 40 } },
    { ...strong, username: 'consistency-high', observed_metrics: { recent_weighted_median_views: 50, view_consistency: 80 } },
    { ...strong, username: 'viral-high', observed_metrics: { recent_weighted_median_views: 40, view_consistency: 70, viral_dependency: 0.8 } },
    { ...strong, username: 'viral-low', observed_metrics: { recent_weighted_median_views: 40, view_consistency: 70, viral_dependency: 0.1 } },
    { ...strong, username: 'vpf-low', observed_metrics: { recent_weighted_median_views: 30, view_consistency: 60, viral_dependency: 0.2, views_per_follower: 0.2 } },
    { ...strong, username: 'vpf-high', observed_metrics: { recent_weighted_median_views: 30, view_consistency: 60, viral_dependency: 0.2, views_per_follower: 0.8 } },
    { ...strong, username: 'sample-low', observed_metrics: { recent_weighted_median_views: 20, view_consistency: 50, viral_dependency: 0.2, views_per_follower: 0.5, sample_size: 20 } },
    { ...strong, username: 'sample-high', observed_metrics: { recent_weighted_median_views: 20, view_consistency: 50, viral_dependency: 0.2, views_per_follower: 0.5, sample_size: 30 } },
  ];
  rows.sort(compareContactRecommendations);
  assert.deepEqual(rows.map(row => row.username), [
    'recent-high', 'recent-low', 'consistency-high', 'consistency-low',
    'viral-low', 'viral-high', 'vpf-high', 'vpf-low', 'sample-high', 'sample-low',
  ]);
});

test('contact recommendation policy gates outreach on readiness and campaign fit', () => {
  const cases = [
    [{ ai_score: 0 }, 'contact'],
    [{ fit: 'partial', ai_score: 99 }, 'review'],
    [{ fit: 'none', ai_score: 99 }, 'skip'],
    [{ fit: 'unknown', clinic_status: 'interested', clinic_rating: 5 }, 'review'],
    [{ fit: 'partial', clinic_status: 'interested', clinic_rating: 5 }, 'review'],
    [{ fit: 'none', clinic_status: 'interested', clinic_rating: 5 }, 'skip'],
    [{ readiness: 'directional', decision_ready: false, ai_score: 99 }, 'review'],
    [{ readiness: 'insufficient', decision_ready: false }, 'need_more_data'],
    [{ analysis_status: 'missing', readiness: null, decision_ready: false }, 'need_more_data'],
    [{ clinic_status: 'not_selected' }, 'skip'],
    [{ clinic_rating: 2 }, 'skip'],
    [{ clinic_status: 'contacted' }, 'already_contacted'],
    [{ clinic_status: 'worked_with' }, 'already_contacted'],
  ];

  for (const [patch, expected] of cases) {
    const input = recommendationFixture(patch);
    assert.equal(classifyContactRecommendation(input).bucket, expected, JSON.stringify(patch));
  }
});

test('contact recommendation marks missing email as not contactable without changing bucket', () => {
  const input = recommendationFixture({ clinic_rating: 5, email: '' });
  const result = classifyContactRecommendation(input);
  assert.equal(result.bucket, 'contact');
  assert.equal(result.contactable, false);
  assert.ok(result.reason_codes.includes('missing_email'));
});

test('contact recommendation sorter is deterministic and transparent', () => {
  const rows = [
    {
      username: 'charlie', bucket: 'contact', clinic_status: 'watching',
      clinic_rating: null, ai_score: 90,
      observed_metrics: { recent_weighted_median_views: 5000, view_consistency: 80, viral_dependency: 0.1 },
    },
    {
      username: 'bravo', bucket: 'contact', clinic_status: 'interested',
      clinic_rating: null, ai_score: 50,
      observed_metrics: { recent_weighted_median_views: 100, view_consistency: 20, viral_dependency: 0.9 },
    },
    {
      username: 'alpha', bucket: 'review', clinic_status: 'watching',
      clinic_rating: 5, ai_score: 100,
      observed_metrics: { recent_weighted_median_views: 10000, view_consistency: 90, viral_dependency: 0.05 },
    },
    {
      username: 'delta', bucket: 'need_more_data', clinic_status: 'watching',
      clinic_rating: null, ai_score: 100, observed_metrics: {},
    },
  ];

  rows.sort(compareContactRecommendations);
  assert.deepEqual(rows.map(row => row.username), ['charlie', 'bravo', 'alpha', 'delta']);
});

test('contact recommendations list uses cached analysis only and survives one analyzer failure', async () => {
  const kols = [
    { id: 'kol-a', workspace_id: 'ws-a', platform: 'tiktok', username: 'alpha', email: 'a@example.com', category: 'skincare', ai_score: 0 },
    { id: 'kol-b', workspace_id: 'ws-a', platform: 'tiktok', username: 'bravo', email: 'b@example.com', ai_score: 80 },
  ];
  const metaByKol = {
    'kol-a': {
      workspace_id: 'ws-a', kol_database_id: 'kol-a', platform: 'tiktok', username: 'alpha',
      saivaree_creator_id: 'creator-a', clinic_status: 'watching', clinic_rating: 4, clinic_notes: null,
    },
    'kol-b': {
      workspace_id: 'ws-a', kol_database_id: 'kol-b', platform: 'tiktok', username: 'bravo',
      saivaree_creator_id: 'creator-b', clinic_status: 'watching', clinic_rating: null, clinic_notes: null,
    },
  };
  const fakeDb = {
    async query(sql, params) {
      assert.match(sql, /workspace_id\s*=\s*\?/i);
      assert.deepEqual(params, ['ws-a']);
      return { rows: kols };
    },
    async queryOne(sql, params) {
      if (/FROM campaigns/i.test(sql)) {
        assert.match(sql, /workspace_id\s*=\s*\?/i);
        assert.deepEqual(params, ['camp-1', 'ws-a']);
        return { id: 'camp-1', filter_criteria: { categories: 'skincare' } };
      }
      if (/FROM saivaree_kol_meta/i.test(sql)) return metaByKol[params[1]] || null;
      return null;
    },
    async exec() {},
  };
  let analyzeCalls = 0;
  const analyzer = {
    async getAnalysis(id) {
      if (id === 'creator-b') {
        const error = new Error('down');
        error.code = 'analyzer_unavailable';
        throw error;
      }
      return {
        analysis_status: 'available',
        observed_metrics: { sample_size: 20, recent_weighted_median_views: 1000, view_consistency: 70, viral_dependency: 0.2 },
        evidence_quality: { readiness: 'decision_grade', decision_ready: true },
      };
    },
    async resolveCreator() { throw new Error('mapping already exists'); },
    async analyze() { analyzeCalls += 1; },
  };
  const handlers = createSaivareeHandlers({ db: fakeDb, analyzer, randomUUID: () => 'uuid-1' });
  const res = makeRes();

  await handlers.getContactRecommendations({ workspace: { id: 'ws-a' }, query: { campaign_id: 'camp-1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.contact, 1);
  assert.equal(res.body.summary.need_more_data, 1);
  assert.equal(res.body.creators.find(row => row.kol_id === 'kol-b').bucket, 'need_more_data');
  assert.ok(res.body.creators.find(row => row.kol_id === 'kol-b').reason_codes.includes('analyzer_unavailable'));
  assert.equal(analyzeCalls, 0);
});

test('contact recommendations require a workspace-scoped campaign before reading Analyzer', async () => {
  let analyzerCalls = 0;
  const fakeDb = {
    async query() { throw new Error('KOL list must not load without a valid campaign'); },
    async queryOne() { return null; },
    async exec() {},
  };
  const analyzer = {
    async getAnalysis() { analyzerCalls += 1; },
    async analyze() { analyzerCalls += 1; },
  };
  const handlers = createSaivareeHandlers({ db: fakeDb, analyzer });

  const missingRes = makeRes();
  await handlers.getContactRecommendations({ workspace: { id: 'ws-a' }, query: {} }, missingRes);
  assert.equal(missingRes.statusCode, 400);
  assert.equal(missingRes.body.code, 'campaign_required');

  const foreignRes = makeRes();
  await handlers.getContactRecommendations({ workspace: { id: 'ws-a' }, query: { campaign_id: 'foreign' } }, foreignRes);
  assert.equal(foreignRes.statusCode, 404);
  assert.equal(analyzerCalls, 0);
});

test('prepare outreach recomputes campaign fit and refuses a creator that only fits another campaign', async () => {
  const kol = {
    id: 'kol-1', workspace_id: 'ws-a', platform: 'tiktok', username: 'skin.creator',
    email: 'skin@example.com', category: 'skincare', source_campaign_id: 'camp-a',
  };
  const meta = {
    workspace_id: 'ws-a', kol_database_id: 'kol-1', platform: 'tiktok', username: 'skin.creator',
    saivaree_creator_id: 'creator-1', clinic_status: 'interested', clinic_rating: 5,
  };
  const fakeDb = {
    async queryOne(sql, params) {
      if (/FROM kol_database/i.test(sql)) return kol;
      if (/FROM campaigns/i.test(sql)) {
        assert.deepEqual(params, ['camp-b', 'ws-a']);
        return { id: 'camp-b', filter_criteria: { categories: 'food' } };
      }
      if (/FROM saivaree_kol_meta/i.test(sql)) return meta;
      return null;
    },
    async exec() { throw new Error('must not write'); },
  };
  const analyzer = {
    async getAnalysis() {
      return {
        analysis_status: 'available',
        observed_metrics: { sample_size: 24, recent_weighted_median_views: 5000 },
        evidence_quality: { readiness: 'decision_grade', decision_ready: true },
      };
    },
    async analyze() { throw new Error('must not analyze'); },
  };
  const handlers = createSaivareeHandlers({ db: fakeDb, analyzer });
  const res = makeRes();

  await handlers.prepareOutreach({
    workspace: { id: 'ws-a' },
    params: { kolId: 'kol-1' },
    body: { campaign_id: 'camp-b' },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'not_contact_ready');
  assert.equal(res.body.bucket, 'skip');
});

test('prepare outreach refuses creator that is not contact ready', async () => {
  const kol = { id: 'kol-1', workspace_id: 'ws-a', platform: 'tiktok', username: 'creator', email: 'c@example.com', ai_score: 99 };
  const meta = {
    workspace_id: 'ws-a', kol_database_id: 'kol-1', platform: 'tiktok', username: 'creator',
    saivaree_creator_id: 'creator-1', clinic_status: 'watching', clinic_rating: null,
  };
  const fakeDb = {
    async queryOne(sql, params) {
      if (/FROM kol_database/i.test(sql)) return kol;
      if (/FROM campaigns/i.test(sql)) return { id: 'camp-1', workspace_id: 'ws-a', name: 'Campaign' };
      if (/FROM saivaree_kol_meta/i.test(sql)) return meta;
      return null;
    },
    async exec() { throw new Error('must not write'); },
  };
  const analyzer = {
    async getAnalysis() {
      return {
        analysis_status: 'available',
        observed_metrics: { sample_size: 15 },
        evidence_quality: { readiness: 'directional', decision_ready: false },
      };
    },
    async resolveCreator() { throw new Error('not needed'); },
    async analyze() { throw new Error('must not analyze'); },
  };
  const handlers = createSaivareeHandlers({ db: fakeDb, analyzer });
  const res = makeRes();

  await handlers.prepareOutreach({
    workspace: { id: 'ws-a' },
    params: { kolId: 'kol-1' },
    body: { campaign_id: 'camp-1' },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'not_contact_ready');
});

test('prepare outreach refuses contact-ready creator without email', async () => {
  const kol = { id: 'kol-1', workspace_id: 'ws-a', platform: 'tiktok', username: 'creator', email: '', source_campaign_id: 'camp-1', ai_score: 80 };
  const meta = {
    workspace_id: 'ws-a', kol_database_id: 'kol-1', platform: 'tiktok', username: 'creator',
    saivaree_creator_id: 'creator-1', clinic_status: 'interested', clinic_rating: null,
  };
  const fakeDb = {
    async queryOne(sql) {
      if (/FROM kol_database/i.test(sql)) return kol;
      if (/FROM campaigns/i.test(sql)) return { id: 'camp-1', workspace_id: 'ws-a', name: 'Campaign' };
      if (/FROM saivaree_kol_meta/i.test(sql)) return meta;
      return null;
    },
    async exec() { throw new Error('must not write'); },
  };
  const analyzer = {
    async getAnalysis() {
      return {
        analysis_status: 'available',
        observed_metrics: { sample_size: 20 },
        evidence_quality: { readiness: 'decision_grade', decision_ready: true },
      };
    },
    async resolveCreator() { throw new Error('not needed'); },
    async analyze() { throw new Error('must not analyze'); },
  };
  const handlers = createSaivareeHandlers({ db: fakeDb, analyzer });
  const res = makeRes();

  await handlers.prepareOutreach({
    workspace: { id: 'ws-a' },
    params: { kolId: 'kol-1' },
    body: { campaign_id: 'camp-1' },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'missing_email');
});

test('prepare outreach creates one workspace-scoped draft and reuses it', async () => {
  const workspaceId = 'outreach-ws';
  const campaignId = 'outreach-camp';
  const databaseKolId = 'outreach-db-kol';
  await exec(
    `INSERT INTO campaigns (id, workspace_id, name, status) VALUES (?, ?, ?, ?)`,
    [campaignId, workspaceId, 'Clinic Campaign', 'active']
  );
  await exec(
    `INSERT INTO kol_database
     (id, workspace_id, platform, username, display_name, profile_url, email, ai_score, scrape_status, source_campaign_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [databaseKolId, workspaceId, 'tiktok', 'ready.creator', 'Ready Creator',
      'https://www.tiktok.com/@ready.creator', 'ready@example.com', 80, 'complete', campaignId]
  );
  await exec(
    `INSERT INTO saivaree_kol_meta
     (workspace_id, kol_database_id, platform, username, saivaree_creator_id, clinic_status, clinic_rating)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [workspaceId, databaseKolId, 'tiktok', 'ready.creator', 'creator-ready', 'interested', 5]
  );

  const analyzer = {
    async getAnalysis() {
      return {
        analysis_status: 'available',
        observed_metrics: { sample_size: 20, recent_weighted_median_views: 5000, view_consistency: 80, viral_dependency: 0.1 },
        evidence_quality: { readiness: 'decision_grade', decision_ready: true },
      };
    },
    async resolveCreator() { throw new Error('not needed'); },
    async analyze() { throw new Error('must not analyze'); },
  };
  const handlers = createSaivareeHandlers({
    db: { query, queryOne, exec },
    analyzer,
    randomUUID: (() => {
      const ids = ['campaign-kol-1', 'contact-1'];
      return () => ids.shift();
    })(),
  });
  const req = {
    workspace: { id: workspaceId },
    params: { kolId: databaseKolId },
    body: { campaign_id: campaignId },
  };

  const first = makeRes();
  await handlers.prepareOutreach(req, first);
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.created, true);
  assert.equal(first.body.status, 'draft');

  const second = makeRes();
  await handlers.prepareOutreach(req, second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.contact_id, first.body.contact_id);

  const contact = await queryOne(
    'SELECT * FROM contacts WHERE id = ? AND workspace_id = ? AND campaign_id = ?',
    [first.body.contact_id, workspaceId, campaignId]
  );
  assert.equal(contact.status, 'draft');
  const count = await queryOne(
    'SELECT COUNT(*) AS n FROM contacts WHERE workspace_id = ? AND campaign_id = ?',
    [workspaceId, campaignId]
  );
  assert.equal(Number(count.n), 1);
});

test('prepare outreach rejects campaign from another workspace', async () => {
  const kol = { id: 'kol-1', workspace_id: 'ws-a', platform: 'tiktok', username: 'creator', email: 'c@example.com', ai_score: 80 };
  const fakeDb = {
    async queryOne(sql) {
      if (/FROM kol_database/i.test(sql)) return kol;
      if (/FROM campaigns/i.test(sql)) return null;
      return null;
    },
    async exec() { throw new Error('must not write'); },
  };
  const handlers = createSaivareeHandlers({
    db: fakeDb,
    analyzer: { async analyze() { throw new Error('must not analyze'); } },
  });
  const res = makeRes();
  await handlers.prepareOutreach({
    workspace: { id: 'ws-a' },
    params: { kolId: 'kol-1' },
    body: { campaign_id: 'foreign-campaign' },
  }, res);
  assert.equal(res.statusCode, 404);
});

test('creator migration normalizes TikTok identity and dry-run performs no writes', async () => {
  const workspaceId = 'migration-ws-dry';
  const beforeKols = await queryOne(
    'SELECT COUNT(*) AS n FROM kol_database WHERE workspace_id = ?',
    [workspaceId]
  );
  const beforeMeta = await queryOne(
    'SELECT COUNT(*) AS n FROM saivaree_kol_meta WHERE workspace_id = ?',
    [workspaceId]
  );

  const normalized = normalizeMigrationRecord({
    platform: 'TikTok',
    username: 'https://www.tiktok.com/@Creator.Name',
    display_name: 'Creator Name',
    clinic_status: 'contacted',
    clinic_rating: 5,
    clinic_notes: 'test',
  });
  assert.equal(normalized.platform, 'tiktok');
  assert.equal(normalized.username, 'creator.name');
  assert.equal(normalized.profile_url, 'https://www.tiktok.com/@creator.name');

  const result = await planMigration({
    db: { queryOne },
    workspaceId,
    records: [
      {
        platform: 'TikTok',
        username: '@Creator.Name',
        display_name: 'Creator Name',
        clinic_status: 'contacted',
        clinic_rating: 5,
        clinic_notes: 'test',
      },
    ],
  });

  assert.deepEqual(result.summary, {
    input: 1,
    matched: 0,
    wouldCreate: 1,
    conflicts: 0,
    invalid: 0,
  });

  const afterKols = await queryOne(
    'SELECT COUNT(*) AS n FROM kol_database WHERE workspace_id = ?',
    [workspaceId]
  );
  const afterMeta = await queryOne(
    'SELECT COUNT(*) AS n FROM saivaree_kol_meta WHERE workspace_id = ?',
    [workspaceId]
  );
  assert.equal(Number(afterKols.n), Number(beforeKols.n));
  assert.equal(Number(afterMeta.n), Number(beforeMeta.n));
});

test('creator migration apply is idempotent and preserves clinic metadata', async () => {
  const workspaceId = 'migration-ws-apply';
  const records = [
    {
      platform: 'tiktok',
      username: '@Idempotent.Creator',
      display_name: 'Idempotent Creator',
      clinic_status: 'worked_with',
      clinic_rating: 4,
      clinic_notes: 'เคยร่วมงาน',
    },
  ];

  const first = await applyMigration({
    db: { queryOne, exec },
    workspaceId,
    records,
    idFactory: () => 'migration-kol-1',
  });
  const second = await applyMigration({
    db: { queryOne, exec },
    workspaceId,
    records,
    idFactory: () => 'must-not-be-used',
  });

  assert.equal(first.created, 1);
  assert.equal(first.matched, 0);
  assert.equal(second.created, 0);
  assert.equal(second.matched, 1);

  const kol = await queryOne(
    'SELECT id, platform, username, display_name, profile_url FROM kol_database WHERE workspace_id = ? AND platform = ? AND LOWER(username) = ?',
    [workspaceId, 'tiktok', 'idempotent.creator']
  );
  assert.equal(kol.id, 'migration-kol-1');
  assert.equal(kol.display_name, 'Idempotent Creator');

  const meta = await getSaivareeMeta(
    { queryOne, exec },
    workspaceId,
    'migration-kol-1'
  );
  assert.equal(meta.clinic_status, 'worked_with');
  assert.equal(meta.clinic_rating, 4);
  assert.equal(meta.clinic_notes, 'เคยร่วมงาน');

  const count = await queryOne(
    'SELECT COUNT(*) AS n FROM kol_database WHERE workspace_id = ? AND platform = ? AND LOWER(username) = ?',
    [workspaceId, 'tiktok', 'idempotent.creator']
  );
  assert.equal(Number(count.n), 1);
});



test('creator migration CLI requires explicit workspace for apply and has no delete mode', () => {
  assert.throws(
    () => parseArgs(['--input', 'migration.json', '--apply']),
    /--workspace is required with --apply/
  );
  assert.throws(
    () => parseArgs(['--input', 'migration.json', '--workspace', 'ws-test', '--delete']),
    /unknown argument: --delete/
  );

  assert.deepEqual(
    parseArgs(['--input', 'migration.json']),
    { apply: false, input: 'migration.json', workspace: null }
  );
});

test('creator migration detects duplicate normalized identities as conflicts', async () => {
  const result = await planMigration({
    db: { queryOne },
    workspaceId: 'migration-ws-conflict',
    records: [
      { platform: 'tiktok', username: '@Same.User', clinic_status: 'watching' },
      { platform: 'tiktok', username: 'same.user', clinic_status: 'contacted' },
    ],
  });

  assert.equal(result.summary.input, 2);
  assert.equal(result.summary.conflicts, 1);
  assert.equal(result.summary.wouldCreate, 0);
});

test('route registration does not crash when Analyzer env is not configured', () => {
  const previousUrl = process.env.SAIVAREE_ANALYZER_BASE_URL;
  const previousKey = process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY;
  delete process.env.SAIVAREE_ANALYZER_BASE_URL;
  delete process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY;

  const registrations = [];
  const app = {
    get(path, permission, handler) { registrations.push(['GET', path, permission, handler]); },
    patch(path, permission, handler) { registrations.push(['PATCH', path, permission, handler]); },
    put(path, permission, handler) { registrations.push(['PUT', path, permission, handler]); },
    post(path, permission, handler) { registrations.push(['POST', path, permission, handler]); },
  };
  const fakeRbac = {
    requirePermission(name) {
      return { permission: name };
    },
  };

  try {
    assert.doesNotThrow(() => registerSaivareeIntelligenceRoutes(app, {
      basePath: '',
      db: { queryOne: async () => null, exec: async () => {} },
      rbac: fakeRbac,
    }));
    assert.equal(registrations.length, 10);
    assert.equal(registrations[0][2].permission, 'kol.read');
    assert.equal(registrations[1][2].permission, 'kol.update');
    assert.equal(
      registrations.find(([, path]) => path === '/api/saivaree/contact-recommendations')[2].permission,
      'kol.read'
    );
    assert.equal(
      registrations.find(([, path]) => path === '/api/saivaree/kols/:kolId/prepare-outreach')[2].permission,
      'contact.create'
    );
  } finally {
    if (previousUrl === undefined) delete process.env.SAIVAREE_ANALYZER_BASE_URL;
    else process.env.SAIVAREE_ANALYZER_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY;
    else process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY = previousKey;
  }
});

