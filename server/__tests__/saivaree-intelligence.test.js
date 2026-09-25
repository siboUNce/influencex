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
  createSaivareeHandlers,
  registerSaivareeIntelligenceRoutes,
} = require('../saivaree/intelligence-routes');
const { createAnalyzerClient } = require('../saivaree/analyzer-client');

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

test('route registration does not crash when Analyzer env is not configured', () => {
  const previousUrl = process.env.SAIVAREE_ANALYZER_BASE_URL;
  const previousKey = process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY;
  delete process.env.SAIVAREE_ANALYZER_BASE_URL;
  delete process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY;

  const registrations = [];
  const app = {
    get(path, permission, handler) { registrations.push(['GET', path, permission, handler]); },
    patch(path, permission, handler) { registrations.push(['PATCH', path, permission, handler]); },
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
    assert.equal(registrations.length, 5);
    assert.equal(registrations[0][2].permission, 'kol.read');
    assert.equal(registrations[1][2].permission, 'kol.update');
  } finally {
    if (previousUrl === undefined) delete process.env.SAIVAREE_ANALYZER_BASE_URL;
    else process.env.SAIVAREE_ANALYZER_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY;
    else process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY = previousKey;
  }
});

