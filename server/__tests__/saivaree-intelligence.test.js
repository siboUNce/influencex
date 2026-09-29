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
  classifyOutreachRecommendation,
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
  assert.equal(classifyOutreachRecommendation({ kol, meta, analysis, campaignFit: fitA }).bucket, 'contact');
  assert.equal(classifyOutreachRecommendation({ kol, meta, analysis, campaignFit: fitB }).bucket, 'skip');
});

test('AI score and human interest cannot change global eligibility or objective ordering', () => {
  for (const readiness of ['decision_grade', 'directional', 'insufficient']) {
    const low = recommendationFixture({ readiness, ai_score: 0 });
    const high = recommendationFixture({ readiness, ai_score: 99, clinic_status: 'interested', clinic_rating: 5 });
    assert.deepEqual(classifyContactRecommendation(low), classifyContactRecommendation(high));
    assert.notEqual(classifyContactRecommendation(high).bucket, 'promising');
  }
  const rows = [
    { username: 'zulu', bucket: 'promising', ai_score: 0, observed_metrics: { views_per_follower: 2 } },
    { username: 'alpha', bucket: 'promising', ai_score: 99, observed_metrics: { views_per_follower: 1 } },
  ];
  assert.deepEqual([...rows].sort(compareContactRecommendations).map(r => r.username), ['zulu', 'alpha']);
  assert.deepEqual(rows.map(r => ({ ...r, ai_score: 99 - r.ai_score })).sort(compareContactRecommendations).map(r => r.username), ['zulu', 'alpha']);
});

test('global eligibility preserves readiness and negative human overrides', () => {
  const cases = [
    [{}, 'eligible_for_promising_pool'],
    [{ readiness: 'directional', clinic_status: 'interested', clinic_rating: 5 }, 'watch'],
    [{ decision_ready: false }, 'watch'],
    [{ readiness: 'insufficient' }, 'need_more_data'],
    [{ readiness: null }, 'need_more_data'],
    [{ analysis_status: 'missing' }, 'need_more_data'],
    [{ analysis_status: 'analyzer_unavailable' }, 'need_more_data'],
    [{ clinic_rating: 1 }, 'skip'], [{ clinic_rating: 2 }, 'skip'],
    [{ clinic_status: 'not_selected' }, 'skip'],
    [{ clinic_status: 'contacted' }, 'already_contacted'],
    [{ clinic_status: 'worked_with' }, 'already_contacted'],
  ];
  for (const [patch, bucket] of cases) assert.equal(classifyContactRecommendation(recommendationFixture(patch)).bucket, bucket);
  const unsupported = recommendationFixture();
  unsupported.kol.platform = 'instagram';
  assert.equal(classifyContactRecommendation(unsupported).bucket, 'need_more_data');
});

test('promising order is views per follower, consistency, viral dependence, recent median, sample, username', () => {
  const base = { views_per_follower: 1, view_consistency: 50, viral_dependency: 0.3, recent_weighted_median_views: 100, sample_size: 20 };
  const rows = [
    ['z-vpf', { views_per_follower: 2, view_consistency: 0 }],
    ['y-consistency', { view_consistency: 60, viral_dependency: 1 }],
    ['x-viral', { viral_dependency: 0.1, recent_weighted_median_views: 0 }],
    ['w-recent', { recent_weighted_median_views: 200 }],
    ['v-sample', { sample_size: 30 }],
    ['alpha', {}], ['bravo', {}],
  ].map(([username, metrics]) => ({ username, bucket: 'promising', observed_metrics: { ...base, ...metrics } }));
  assert.deepEqual(rows.reverse().sort(compareContactRecommendations).map(r => r.username),
    ['z-vpf', 'y-consistency', 'x-viral', 'w-recent', 'v-sample', 'alpha', 'bravo']);
  const unknown = { username: 'aaa', bucket: 'promising', observed_metrics: {} };
  assert.equal([...rows, unknown].sort(compareContactRecommendations).at(-1), unknown);
});

test('watch ranks decision grade first and human history only after objective ties', () => {
  const row = (username, readiness, views, clinic_status = 'watching', clinic_rating = null) => ({
    username, bucket: 'watch', evidence_quality: { readiness }, observed_metrics: { views_per_follower: views }, clinic_status, clinic_rating,
  });
  const rows = [row('directional', 'directional', 100), row('objective', 'decision_grade', 2),
    row('interested', 'decision_grade', 1, 'interested'), row('rated', 'decision_grade', 1, 'watching', 5), row('unrated', 'decision_grade', 1)];
  assert.deepEqual(rows.sort(compareContactRecommendations).map(r => r.username), ['objective', 'interested', 'rated', 'unrated', 'directional']);
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
    assert.equal(classifyOutreachRecommendation(input).bucket, expected, JSON.stringify(patch));
  }
});

test('contact recommendation marks missing email as not contactable without changing bucket', () => {
  const input = recommendationFixture({ clinic_rating: 5, email: '' });
  const result = classifyOutreachRecommendation(input);
  assert.equal(result.bucket, 'contact');
  assert.equal(result.contactable, false);
  assert.ok(result.reason_codes.includes('missing_email'));
});

function scanCandidate(index = 0, overrides = {}) {
  return { creator_id: `creator-${index}`, platform: 'tiktok', username: `creator-${index}`,
    display_name: `Creator ${index}`, profile_url: `https://www.tiktok.com/@creator-${index}`,
    avatar_url: 'https://example.com/avatar.png', followers: 1000,
    analysis_status: 'available', analyzed_at: '2026-09-28T00:00:00Z',
    observed_metrics: { views_per_follower: index, sample_size: 20 },
    evidence_quality: { readiness: 'decision_grade', decision_ready: true },
    eligibility: { eligible: true }, discovery_provenance: { source: 'scan' }, ...overrides };
}

function scanHarness(candidates, locals = []) {
  const calls = { scan: 0, sql: 0, forbidden: 0 };
  const forbidden = async () => { calls.forbidden++; throw new Error('Forbidden GET dependency'); };
  const analyzer = {
    getPromisingStars: async () => { calls.scan++; return { candidates,
      active_run: { id: 'active', status: 'running' }, latest_completed_run: { id: 'done', finished_at: '2026-09-28T00:00:00Z' },
      funnel: { unique_discovered: 300, analyzed_pool: candidates.length } }; },
    resolveCreator: forbidden, getAnalysis: forbidden, analyze: forbidden, refreshPromisingStars: forbidden,
  };
  const db = {
    query: async (sql, params) => {
      calls.sql++;
      assert.match(sql, /WHERE k.workspace_id = \?/);
      assert.match(sql, /m.workspace_id = k.workspace_id/);
      assert.doesNotMatch(sql, /FROM campaigns/i);
      assert.deepEqual(params, ['ws-scan']);
      return { rows: locals };
    },
    queryOne: forbidden, exec: forbidden,
  };
  return { handlers: createSaivareeHandlers({ db, analyzer }), calls, analyzer, db };
}

test('cached scan is the only candidate source and local context is merged in one workspace query', async () => {
  const h = scanHarness([scanCandidate(2), scanCandidate(1)], [
    { id: 'local-2', platform: ' TikTok ', username: '@CREATOR-2', email: 'clinic@example.com', clinic_status: 'interested', clinic_rating: 5 },
    { id: 'not-in-scan', platform: 'tiktok', username: 'manual-only', clinic_rating: 5 },
  ]);
  const res = makeRes();
  await h.handlers.getContactRecommendations({ workspace: { id: 'ws-scan' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls, { scan: 1, sql: 1, forbidden: 0 });
  assert.equal(res.body.creators.length, 2);
  const [local, fresh] = res.body.creators;
  assert.equal(local.kol_id, 'local-2');
  assert.equal(local.email, 'clinic@example.com');
  assert.equal(local.clinic_rating, 5);
  assert.equal(local.clinic_status, 'interested');
  assert.equal(fresh.kol_id, null);
  assert.equal(fresh.email, '');
  assert.equal(fresh.clinic_status, 'watching');
  assert.equal(fresh.clinic_rating, null);
  assert.equal(fresh.profile_url, 'https://www.tiktok.com/@creator-1');
  assert.deepEqual(fresh.discovery_provenance, { source: 'scan' });
  assert.equal(res.body.scan.funnel.unique_discovered, 300);
  assert.equal(res.body.scan.active_run.status, 'running');
});

test('legacy scan shortlist retains all eligible creators and ignores AI scores', async () => {
  const candidates = Array.from({ length: 11 }, (_, i) => scanCandidate(i, { ai_score: 99 - i }));
  const h = scanHarness(candidates);
  const res = makeRes();
  await h.handlers.getContactRecommendations({ workspace: { id: 'ws-scan' } }, res);
  assert.equal(res.body.summary.promising, 11);
  assert.equal(res.body.summary.watch, 0);
  assert.deepEqual(res.body.creators.map(r => r.rank), [1,2,3,4,5,6,7,8,9,10,11]);
  assert.equal(res.body.creators[0].creator_id, 'creator-10');
  assert.equal(res.body.creators[10].creator_id, 'creator-0');
  for (const row of res.body.creators) {
    assert.equal('ai_score' in row, false);
    assert.equal('campaign_fit' in row, false);
  }
  assert.equal(h.calls.forbidden, 0);
});

test('local negative overrides survive scan discovery and different platforms do not match', async () => {
  const h = scanHarness([scanCandidate(1), scanCandidate(2), scanCandidate(3)], [
    { id: 'skip', username: 'creator-1', platform: 'tiktok', clinic_rating: 2 },
    { id: 'contacted', username: 'creator-2', platform: 'tiktok', clinic_status: 'contacted' },
    { id: 'wrong-platform', username: 'creator-3', platform: 'instagram', clinic_rating: 1 },
  ]);
  const res = makeRes();
  await h.handlers.getContactRecommendations({ workspace: { id: 'ws-scan' } }, res);
  assert.equal(res.body.summary.skip, 1);
  assert.equal(res.body.summary.already_contacted, 1);
  assert.equal(res.body.creators[0].kol_id, null);
  assert.equal(res.body.creators[0].bucket, 'promising');
});

test('deep analysis analyzer client uses exact internal routes and bodies', async () => {
  const calls = [];
  const client = createAnalyzerClient({ baseUrl: 'http://analyzer.test', apiKey: 'k', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return fakeResponse(url.endsWith('/execute') ? 202 : 200, { ok: true });
  } });
  await client.getCreatorDiscovery();
  await client.createDeepAnalysisPlan({ sourceRunId: '11111111-1111-4111-8111-111111111111' });
  await client.createDeepAnalysisPlan({ sourceRunId: '11111111-1111-4111-8111-111111111111', creatorRefs: ['22222222-2222-4222-8222-222222222222'] });
  await client.executeDeepAnalysis({ sourceRunId: '11111111-1111-4111-8111-111111111111', creatorRefs: ['22222222-2222-4222-8222-222222222222'], planToken: 'a'.repeat(64), requestId: 'request-1' });
  await client.getDeepAnalysisJob('11111111-1111-4111-8111-111111111111');
  await client.getDeepAnalysisCreator('33333333-3333-4333-8333-333333333333');
  assert.deepEqual(calls.map(call => call.url), [
    'http://analyzer.test/internal/influencex/creator-discovery',
    'http://analyzer.test/internal/influencex/deep-analysis/plan',
    'http://analyzer.test/internal/influencex/deep-analysis/plan',
    'http://analyzer.test/internal/influencex/deep-analysis/execute',
    'http://analyzer.test/internal/influencex/deep-analysis/jobs/11111111-1111-4111-8111-111111111111',
    'http://analyzer.test/internal/influencex/deep-analysis/creators/33333333-3333-4333-8333-333333333333',
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { source_run_id: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(JSON.parse(calls[2].options.body), { source_run_id: '11111111-1111-4111-8111-111111111111', creator_refs: ['22222222-2222-4222-8222-222222222222'] });
  assert.deepEqual(JSON.parse(calls[3].options.body), { source_run_id: '11111111-1111-4111-8111-111111111111', creator_refs: ['22222222-2222-4222-8222-222222222222'], plan_token: 'a'.repeat(64), request_id: 'request-1' });
});

test('explicit analyzed tiers remain promising despite missing legacy readiness', () => {
  for (const candidate_tier of ['decision_grade', 'deep_analyzed']) {
    const analysis = scanCandidate(1, { candidate_tier, analysis_status: 'missing', evidence_quality: {} });
    assert.deepEqual(classifyContactRecommendation({ kol: analysis, analysis }), {
      bucket: 'promising', reason_codes: [candidate_tier],
    });
  }
});

test('all 50 analyzer candidates flow through with tiers, upstream ordering and no paid work', async () => {
  const candidates = Array.from({ length: 50 }, (_, index) => {
    const candidate_tier = index < 4 ? 'decision_grade' : index < 6 ? 'deep_analyzed' : 'discovery_only';
    return scanCandidate(index, {
      candidate_tier, selection_rank: 50 - index,
      enrichment_status: candidate_tier === 'discovery_only' ? 'not_selected' : 'completed',
      eligibility: { classification: 'ELIGIBLE_INFLUENCER' },
      analysis_status: candidate_tier === 'discovery_only' ? 'missing' : 'available',
      evidence_quality: candidate_tier === 'discovery_only' ? {} : {
        readiness: candidate_tier === 'decision_grade' ? 'decision_grade' : 'directional',
        decision_ready: candidate_tier === 'decision_grade',
      },
    });
  });
  const h = scanHarness([...candidates].reverse());
  const res = makeRes();
  await h.handlers.getContactRecommendations({ workspace: { id: 'ws-scan' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.creators.length, 50);
  assert.deepEqual(res.body.summary, { promising: 50, watch: 0, need_more_data: 0, already_contacted: 0, skip: 0 });
  const expected = [candidates.slice(0, 4), candidates.slice(4, 6), candidates.slice(6)].flatMap(group => group.reverse());
  assert.deepEqual(res.body.creators.map(row => row.creator_id), expected.map(row => row.creator_id));
  assert.deepEqual(res.body.creators.map(row => row.rank), Array.from({ length: 50 }, (_, i) => i + 1));
  for (const row of res.body.creators) {
    const original = candidates.find(candidate => candidate.creator_id === row.creator_id);
    for (const key of ['candidate_tier', 'selection_rank', 'enrichment_status', 'analysis_status', 'analyzed_at',
      'observed_metrics', 'evidence_quality', 'eligibility', 'discovery_provenance']) {
      assert.deepEqual(row[key], original[key], key);
    }
    if (row.candidate_tier === 'discovery_only') {
      assert.deepEqual(row.reason_codes, ['discovery_only']);
      assert.notEqual(row.evidence_quality.readiness, 'decision_grade');
    }
  }
  assert.deepEqual(h.calls, { scan: 1, sql: 1, forbidden: 0 });
});

test('upstream exclusions win over every tier and contradictory legacy eligibility', () => {
  for (const candidate_tier of ['decision_grade', 'deep_analyzed', 'discovery_only']) {
    for (const eligibility of [
      { classification: 'BUSINESS_ACCOUNT', eligible: true },
      { classification: 'NOT_ELIGIBLE' }, { eligible: false },
    ]) {
      const analysis = scanCandidate(0, { candidate_tier, eligibility });
      assert.deepEqual(classifyContactRecommendation({ kol: analysis, analysis }), {
        bucket: 'skip', reason_codes: ['ineligible_candidate'],
      });
    }
  }
});

test('discovery tier requires upstream eligibility and cannot inherit decision-grade readiness', () => {
  for (const eligibility of [{ classification: 'ELIGIBLE_INFLUENCER' }, { eligible: true }, {}]) {
    const analysis = scanCandidate(0, { candidate_tier: 'discovery_only', eligibility });
    assert.deepEqual(classifyContactRecommendation({ kol: analysis, analysis }), {
      bucket: Object.keys(eligibility).length ? 'promising' : 'need_more_data', reason_codes: ['discovery_only'],
    });
  }
});

test('candidate tiers cannot override clinic decisions or unsupported platforms', async () => {
  for (const candidate_tier of ['decision_grade', 'deep_analyzed', 'discovery_only']) {
    const h = scanHarness(Array.from({ length: 6 }, (_, i) => scanCandidate(i, { candidate_tier })), [
      { username: 'creator-0', platform: 'tiktok', clinic_status: 'contacted' },
      { username: 'creator-1', platform: 'tiktok', clinic_status: 'worked_with' },
      { username: 'creator-2', platform: 'tiktok', clinic_status: 'not_selected' },
      { username: 'creator-3', platform: 'tiktok', clinic_rating: 2 },
      { username: 'creator-4', platform: 'tiktok', clinic_rating: 1 },
    ]);
    const res = makeRes();
    await h.handlers.getContactRecommendations({ workspace: { id: 'ws-scan' } }, res);
    assert.equal(res.body.summary.already_contacted, 2);
    assert.equal(res.body.summary.skip, 3);
    assert.ok(res.body.creators.every(row => row.candidate_tier === candidate_tier));
    const unsupported = scanCandidate(1, { candidate_tier, platform: 'instagram' });
    assert.deepEqual(classifyContactRecommendation({ kol: unsupported, analysis: unsupported }), {
      bucket: 'need_more_data', reason_codes: ['unsupported_platform'],
    });
  }
});

test('tier order precedes upstream rank, which precedes metrics with deterministic fallbacks', () => {
  const row = (username, candidate_tier, selection_rank, views = 0) => ({
    username, candidate_tier, selection_rank, bucket: 'promising', observed_metrics: { views_per_follower: views },
  });
  const rows = [row('discovery', 'discovery_only', 1, 999), row('deep', 'deep_analyzed', 2),
    row('decision-second', 'decision_grade', 50, 999), row('decision-first', 'decision_grade', 49),
    row('missing-z', 'decision_grade', null), row('missing-a', 'decision_grade', undefined)];
  assert.deepEqual(rows.sort(compareContactRecommendations).map(row => row.username),
    ['decision-first', 'decision-second', 'missing-a', 'missing-z', 'deep', 'discovery']);
});

test('browse tiers never bypass evidence or campaign-fit gates for outreach', () => {
  for (const candidate_tier of ['decision_grade', 'deep_analyzed', 'discovery_only']) {
    const input = recommendationFixture({ analysis_status: 'missing', readiness: null, decision_ready: false });
    input.analysis.candidate_tier = candidate_tier;
    const recommendation = classifyOutreachRecommendation(input);
    assert.equal(recommendation.bucket, 'need_more_data');
    assert.equal(recommendation.contactable, false);
  }
});

test('scan GET fails with stable 503 instead of silently returning local creators', async () => {
  const h = scanHarness([]);
  h.analyzer.getPromisingStars = async () => { throw Object.assign(new Error('secret detail'), { code: 'analyzer_unavailable' }); };
  const res = makeRes();
  await h.handlers.getContactRecommendations({ workspace: { id: 'ws-scan' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'analyzer_unavailable');
  assert.equal(h.calls.sql, 0);
  assert.equal(h.calls.forbidden, 0);
  assert.doesNotMatch(JSON.stringify(res.body), /secret/);
});

test('Analyzer scan client uses internal auth and exact cached GET / explicit refresh POST contracts', async () => {
  const calls = [];
  const client = createAnalyzerClient({ baseUrl: 'http://analyzer.test', apiKey: 'test-internal-key', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return fakeResponse(options.method === 'POST' ? 202 : 200, { status: 'queued' });
  } });
  await client.getPromisingStars();
  await client.refreshPromisingStars({ requestId: 'ws:promising-stars:one' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://analyzer.test/internal/influencex/promising-stars');
  assert.equal(calls[0].options.method || 'GET', 'GET');
  assert.equal(calls[1].url, 'http://analyzer.test/internal/influencex/promising-stars/refresh');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { request_id: 'ws:promising-stars:one' });
  for (const call of calls) assert.equal(call.options.headers['X-InfluenceX-Internal-Key'], 'test-internal-key');
});

test('explicit refresh makes one call per request with unique workspace request IDs and no DB writes', async () => {
  const calls = [];
  const handlers = createSaivareeHandlers({ db: {}, analyzer: {
    refreshPromisingStars: async args => { calls.push(args); return { id: 'run-1', status: 'queued' }; },
  } });
  for (let i = 0; i < 2; i++) {
    const res = makeRes();
    await handlers.refreshContactRecommendations({ workspace: { id: 'ws-scan' }, body: {} }, res);
    assert.equal(res.statusCode, 202);
    assert.equal(calls.length, i + 1);
    assert.equal(res.body.status, 'queued');
    assert.equal(res.body.request_id, calls[i].requestId);
    assert.match(res.body.request_id, /^ws-scan:promising-stars:/);
  }
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  const invalid = makeRes();
  await handlers.refreshContactRecommendations({ workspace: { id: 'ws-scan' }, body: { max_enrichments: 999 } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.length, 2);
});

test('refresh maps unavailable and safe Analyzer rejection statuses without retries or secret details', async () => {
  for (const status of [503, 409, 422, 429]) {
    let calls = 0;
    const handlers = createSaivareeHandlers({ db: {}, analyzer: { refreshPromisingStars: async () => {
      calls++; throw Object.assign(new Error('secret provider payload'), status === 503 ? { code: 'analyzer_unavailable' } : { status });
    } } });
    const res = makeRes();
    await handlers.refreshContactRecommendations({ workspace: { id: 'ws' }, body: {} }, res);
    assert.equal(res.statusCode, status);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(res.body), /secret/);
  }
});

test('creator discovery proxy shares browse mapping and preserves local overrides', async () => {
  const localDb = { query: async () => ({ rows: [
    { id: 'local-1', platform: 'tiktok', username: '@creator-1', email: 'x@example.com', clinic_status: 'contacted', clinic_rating: 5 },
    { id: 'local-2', platform: 'tiktok', username: 'creator-2', email: '', clinic_status: 'not_selected', clinic_rating: 1 },
  ] }) };
  const mappedHandlers = createSaivareeHandlers({ db: localDb, analyzer: { getCreatorDiscovery: async () => ({ candidates: Array.from({ length: 50 }, (_, i) => scanCandidate(i)), latest_completed_run: { id: 'run-1' } }) } });
  const res = makeRes();
  await mappedHandlers.getCreatorDiscovery({ workspace: { id: 'ws' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.creators.length, 50);
  assert.equal(res.body.scan.latest_completed_run.id, 'run-1');
  assert.equal(res.body.creators.find(row => row.username === 'creator-1').clinic_status, 'contacted');
  assert.equal(res.body.creators.find(row => row.username === 'creator-2').bucket, 'skip');
});

test('deep analysis proxy validates UUID refs and unknown body keys without calling Analyzer', async () => {
  let calls = 0;
  const handlers = createSaivareeHandlers({ db: {}, analyzer: { async createDeepAnalysisPlan() { calls++; } } });
  const invalid = makeRes();
  await handlers.createDeepAnalysisPlan({ body: { source_run_id: 'not-a-uuid', unsafe: 'x' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls, 0);
  const duplicate = makeRes();
  await handlers.createDeepAnalysisPlan({ body: { source_run_id: '11111111-1111-4111-8111-111111111111', creator_refs: ['22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222'] } }, duplicate);
  assert.equal(duplicate.statusCode, 400);
  assert.equal(calls, 0);
});

test('deep analysis execute forwards exact request and maps stale plan once', async () => {
  let calls = 0;
  const args = [];
  const handlers = createSaivareeHandlers({ db: {}, analyzer: { async executeDeepAnalysis(body) { calls++; args.push(body); throw Object.assign(new Error('secret'), { status: 409 }); } } });
  const res = makeRes();
  await handlers.executeDeepAnalysis({ body: { source_run_id: '11111111-1111-4111-8111-111111111111', creator_refs: ['22222222-2222-4222-8222-222222222222'], plan_token: 'a'.repeat(64), request_id: 'browser-request' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'stale_plan');
  assert.doesNotMatch(JSON.stringify(res.body), /secret/);
  assert.equal(calls, 1);
  assert.deepEqual(args[0], { sourceRunId: '11111111-1111-4111-8111-111111111111', creatorRefs: ['22222222-2222-4222-8222-222222222222'], planToken: 'a'.repeat(64), requestId: 'browser-request' });
});

test('deep analysis execute success, status, and lookup proxies pass through exactly once', async () => {
  const calls = [];
  const analyzer = {
    async executeDeepAnalysis(body) { calls.push(['execute', body]); return { run: { id: 'run-1' } }; },
    async getDeepAnalysisJob(id) { calls.push(['job', id]); return { id }; },
    async getDeepAnalysisCreator(ref) { calls.push(['creator', ref]); return { creator_ref: ref }; },
  };
  const handlers = createSaivareeHandlers({ db: {}, analyzer });
  const execute = makeRes();
  await handlers.executeDeepAnalysis({ body: { source_run_id: '11111111-1111-4111-8111-111111111111', creator_refs: ['22222222-2222-4222-8222-222222222222'], plan_token: 'b'.repeat(64), request_id: 'browser-request' } }, execute);
  assert.equal(execute.statusCode, 202);
  const job = makeRes();
  await handlers.getDeepAnalysisJob({ params: { runId: 'run-1' } }, job);
  const creator = makeRes();
  await handlers.getDeepAnalysisCreator({ params: { creatorRef: '22222222-2222-4222-8222-222222222222' } }, creator);
  assert.equal(job.body.id, 'run-1');
  assert.equal(creator.body.creator_ref, '22222222-2222-4222-8222-222222222222');
  assert.equal(calls.length, 3);
});

test('deep analysis execute rejects unsafe request ids and malformed lookup ids without calls', async () => {
  let calls = 0;
  const handlers = createSaivareeHandlers({ db: {}, analyzer: { async executeDeepAnalysis() { calls++; }, async getDeepAnalysisJob() { calls++; }, async getDeepAnalysisCreator() { calls++; } } });
  const badRequest = makeRes();
  await handlers.executeDeepAnalysis({ body: { source_run_id: '11111111-1111-4111-8111-111111111111', creator_refs: ['22222222-2222-4222-8222-222222222222'], plan_token: 'a'.repeat(64), request_id: 'bad/id' } }, badRequest);
  const badJob = makeRes();
  await handlers.getDeepAnalysisJob({ params: { runId: '../run' } }, badJob);
  const badCreator = makeRes();
  await handlers.getDeepAnalysisCreator({ params: { creatorRef: 'not-a-uuid' } }, badCreator);
  assert.equal(badRequest.statusCode, 400);
  assert.equal(badJob.statusCode, 400);
  assert.equal(badCreator.statusCode, 400);
  assert.equal(calls, 0);
});

test('creator discovery bridge reuses a workspace KOL and never starts paid analysis', async () => {
  const candidate = scanCandidate(1, { candidate_tier: 'discovery_only', eligibility: { classification: 'ELIGIBLE_INFLUENCER' } });
  candidate.creator_id = '11111111-1111-4111-8111-111111111111';
  const calls = { analyze: 0, refresh: 0, query: 0 };
  const local = { id: 'local-kol', workspace_id: 'ws-a', platform: 'tiktok', username: 'creator-1', saivaree_creator_id: candidate.creator_id, clinic_status: 'watching', clinic_rating: null };
  const db = {
    async queryOne(sql, params) { calls.query++; if (/kol_database/i.test(sql)) return local; if (/saivaree_kol_meta/i.test(sql)) return local; return null; },
    async exec() { throw new Error('must not write on reuse'); },
  };
  const analyzer = { async getCreatorDiscovery() { return { candidates: [candidate] }; }, async analyze() { calls.analyze++; }, async refreshPromisingStars() { calls.refresh++; } };
  const handlers = createSaivareeHandlers({ db, analyzer });
  const res = makeRes();
  await handlers.bridgeCreatorDiscovery({ workspace: { id: 'ws-a' }, params: { creatorRef: candidate.creator_id }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { kol_id: 'local-kol' });
  assert.equal(calls.analyze, 0);
  assert.equal(calls.refresh, 0);
});

test('creator discovery bridge creates an idempotent local KOL from an eligible cached candidate', async () => {
  const candidate = scanCandidate(2, { candidate_tier: 'discovery_only', eligibility: { classification: 'ELIGIBLE_INFLUENCER' } });
  candidate.creator_id = '22222222-2222-4222-8222-222222222222';
  const inserts = [];
  const db = {
    async queryOne(sql) { if (/kol_database/i.test(sql)) return null; if (/saivaree_kol_meta/i.test(sql)) return null; return null; },
    async exec(sql, params) { inserts.push({ sql, params }); },
  };
  const handlers = createSaivareeHandlers({ db, analyzer: { async getCreatorDiscovery() { return { candidates: [candidate] }; } } });
  const res = makeRes();
  await handlers.bridgeCreatorDiscovery({ workspace: { id: 'ws-a' }, params: { creatorRef: candidate.creator_id }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.kol_id, /^discovery-[0-9a-f]{40}$/);
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].sql, /INSERT INTO kol_database/i);
  assert.match(inserts[1].sql, /INSERT INTO saivaree_kol_meta/i);
});

test('creator discovery bridge recovers a concurrent deterministic identity insert', async () => {
  const candidate = scanCandidate(4, { candidate_tier: 'discovery_only', eligibility: { classification: 'ELIGIBLE_INFLUENCER' } });
  candidate.creator_id = '44444444-4444-4444-8444-444444444444';
  let inserts = 0;
  const db = {
    async queryOne(sql, params) {
      if (/WHERE id = \?/i.test(sql)) return { id: params[0], workspace_id: 'ws-a', platform: 'tiktok', username: 'creator-4', saivaree_creator_id: candidate.creator_id, clinic_status: 'watching' };
      if (/kol_database/i.test(sql)) return null;
      return { id: params[1], platform: 'tiktok', username: 'creator-4', saivaree_creator_id: candidate.creator_id, clinic_status: 'watching' };
    },
    async exec(sql) { inserts++; if (/INSERT INTO kol_database/i.test(sql)) throw Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }); },
  };
  const handlers = createSaivareeHandlers({ db, analyzer: { async getCreatorDiscovery() { return { candidates: [candidate] }; } } });
  const res = makeRes();
  await handlers.bridgeCreatorDiscovery({ workspace: { id: 'ws-a' }, params: { creatorRef: candidate.creator_id }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.kol_id, /^discovery-[0-9a-f]{40}$/);
  assert.equal(inserts, 2);
});

test('creator discovery bridge uses the real schema and reuses its deterministic row', async () => {
  const workspaceId = `bridge-real-${process.pid}`;
  const creatorRef = '55555555-5555-4555-8555-555555555555';
  const candidate = scanCandidate(5, { creator_id: creatorRef, candidate_tier: 'discovery_only', eligibility: { classification: 'ELIGIBLE_INFLUENCER' }, username: ' @Bridge.Real ' });
  const handlers = createSaivareeHandlers({ db: { query, queryOne, exec }, analyzer: { async getCreatorDiscovery() { return { candidates: [candidate] }; } } });
  const req = { workspace: { id: workspaceId }, params: { creatorRef }, body: {} };
  const first = makeRes();
  await handlers.bridgeCreatorDiscovery(req, first);
  const second = makeRes();
  await handlers.bridgeCreatorDiscovery(req, second);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(second.body, first.body);
  const count = await queryOne('SELECT COUNT(*) AS n FROM kol_database WHERE workspace_id = ? AND platform = ? AND username = ?', [workspaceId, 'tiktok', 'bridge.real']);
  assert.equal(Number(count.n), 1);
  const meta = await queryOne('SELECT saivaree_creator_id FROM saivaree_kol_meta WHERE workspace_id = ? AND kol_database_id = ?', [workspaceId, first.body.kol_id]);
  assert.equal(meta.saivaree_creator_id, creatorRef);
});

test('creator discovery bridge rejects unknown, unsupported, ineligible, and negative clinic candidates', async () => {
  const base = scanCandidate(3, { candidate_tier: 'discovery_only', eligibility: { classification: 'ELIGIBLE_INFLUENCER' } });
  base.creator_id = '33333333-3333-4333-8333-333333333333';
  const local = { id: 'local', platform: 'tiktok', username: 'creator-3', clinic_status: 'contacted', clinic_rating: 5 };
  const db = { async queryOne(sql) { if (/kol_database/i.test(sql)) return local; if (/saivaree_kol_meta/i.test(sql)) return local; return null; }, async exec() { throw new Error('must not write'); } };
  let current = base;
  const handlers = createSaivareeHandlers({ db, analyzer: { async getCreatorDiscovery() { return { candidates: current ? [current] : [] }; } } });
  for (const [candidate, status] of [[null, 404], [{ ...base, platform: 'instagram' }, 400], [{ ...base, eligibility: { classification: 'INELIGIBLE' } }, 409], [base, 409]]) {
    current = candidate;
    const res = makeRes();
    await handlers.bridgeCreatorDiscovery({ workspace: { id: 'ws-a' }, params: { creatorRef: candidate?.creator_id || base.creator_id }, body: {} }, res);
    assert.equal(res.statusCode, status);
  }
});

test('deep analysis guards malformed bodies, tokens, duplicate UUID casing and path traversal', async () => {
  const source_run_id = '11111111-1111-4111-8111-111111111111';
  const creator = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let calls = 0;
  const forbidden = async () => { calls++; throw Error('must not call analyzer'); };
  const handlers = createSaivareeHandlers({ db: {}, analyzer: { createDeepAnalysisPlan: forbidden, executeDeepAnalysis: forbidden, getDeepAnalysisJob: forbidden } });
  for (const body of [null, [], {}, { source_run_id, creator_refs: [] }, { source_run_id, creator_refs: 'bad' },
    { source_run_id, creator_refs: Array(51).fill(creator) }, { source_run_id, creator_refs: [creator, creator.toUpperCase()] },
    { source_run_id, creator_refs: [null] }, { source_run_id, headers: {} }]) {
    const res = makeRes(); await handlers.createDeepAnalysisPlan({ body }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  const body = { source_run_id, creator_refs: [creator], plan_token: 'a'.repeat(64), request_id: 'request-1' };
  for (const patch of [{ plan_token: '' }, { plan_token: 'z'.repeat(64) }, { plan_token: 'a'.repeat(65) },
    { creator_refs: [] }, { request_id: '' }, { request_id: 'x\ny' }, { request_id: 'x'.repeat(129) }, { url: 'https://example.test' }]) {
    const res = makeRes(); await handlers.executeDeepAnalysis({ body: { ...body, ...patch } }, res);
    assert.equal(res.statusCode, 400);
  }
  for (const runId of ['.', '..', '%2f..', 'https://example.test', 'x\\y', ' x ', 'x'.repeat(129)]) {
    const res = makeRes(); await handlers.getDeepAnalysisJob({ params: { runId } }, res);
    assert.equal(res.statusCode, 400, runId);
  }
  assert.equal(calls, 0);
});

test('plan preview is a single read-only call and upstream errors never expose details or retry', async () => {
  const source_run_id = '11111111-1111-4111-8111-111111111111';
  const creator_refs = ['22222222-2222-4222-8222-222222222222'];
  const body = { source_run_id, creator_refs, plan_token: 'a'.repeat(64), request_id: 'request-1' };
  const preview = { source_run_id, creator_refs, plan_token: body.plan_token, requested_count: 1, fundable_count: 1 };
  let calls = 0;
  const handlers = createSaivareeHandlers({ db: {}, analyzer: {
    async createDeepAnalysisPlan(args) { calls++; assert.deepEqual(args, { sourceRunId: source_run_id, creatorRefs: undefined }); return preview; },
    async executeDeepAnalysis() { throw Error('no execution during plan'); },
  } });
  const planned = makeRes(); await handlers.createDeepAnalysisPlan({ body: { source_run_id } }, planned);
  assert.equal(calls, 1); assert.deepEqual(planned.body, preview);
  for (const status of [400, 404, 409, 422, 429, 503]) {
    let attempts = 0;
    const client = createAnalyzerClient({ baseUrl: 'http://analyzer.test', apiKey: 'private-service-key', fetchImpl: async (_url, options) => {
      attempts++; assert.equal(options.headers['X-InfluenceX-Internal-Key'], 'private-service-key');
      return fakeResponse(status, { detail: 'private-service-key: secret internals' });
    } });
    const handler = createSaivareeHandlers({ db: {}, analyzer: client });
    const res = makeRes(); await handler.executeDeepAnalysis({ body }, res);
    assert.equal(res.statusCode, status);
    assert.doesNotMatch(JSON.stringify(res.body), /private-service-key|secret internals/);
    assert.equal(attempts, 1);
  }
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
    assert.equal(registrations.length, 17);
    assert.equal(registrations[0][2].permission, 'kol.read');
    assert.equal(registrations[1][2].permission, 'kol.update');
    assert.equal(
      registrations.find(([, path]) => path === '/api/saivaree/contact-recommendations')[2].permission,
      'kol.read'
    );
    assert.equal(
      registrations.find(([, path]) => path === '/api/saivaree/contact-recommendations/refresh')[2].permission,
      'kol.update'
    );
    assert.equal(
      registrations.find(([, path]) => path === '/api/saivaree/creator-discovery')[2].permission,
      'kol.read'
    );
    assert.equal(
      registrations.find(([, path]) => path === '/api/saivaree/creator-discovery/:creatorRef/kol')[2].permission,
      'kol.update'
    );
    assert.equal(
      registrations.find(([, path]) => path === '/api/saivaree/deep-analysis/execute')[2].permission,
      'kol.update'
    );
    for (const path of [
      '/api/saivaree/deep-analysis/plan',
      '/api/saivaree/deep-analysis/jobs/:runId',
      '/api/saivaree/deep-analysis/creators/:creatorRef',
    ]) {
      assert.equal(registrations.find(([, registered]) => registered === path)[2].permission, 'kol.read');
    }
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


test('creator discovery falls back only on 404 to the legacy cached GET without paid calls', async () => {
  for (const status of [200, 404, 401, 429, 503]) {
    const calls = [];
    const scan = { candidates: [scanCandidate(1)] };
    const client = createAnalyzerClient({ baseUrl: 'http://analyzer.test', apiKey: 'fake-key', fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.method || 'GET', 'GET');
      assert.equal(options.body, undefined);
      return fakeResponse(calls.length === 1 ? status : 200, scan);
    } });
    if ([200, 404].includes(status)) assert.deepEqual(await client.getCreatorDiscovery(), scan);
    else await assert.rejects(() => client.getCreatorDiscovery());
    assert.deepEqual(calls, status === 404
      ? ['http://analyzer.test/internal/influencex/creator-discovery', 'http://analyzer.test/internal/influencex/promising-stars']
      : ['http://analyzer.test/internal/influencex/creator-discovery']);
  }
});
