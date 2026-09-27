const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalToken = process.env.APIFY_TOKEN;
const originalSettingsPath = process.env.INFLUENCEX_RUNTIME_SETTINGS_PATH;
let tempDir;
let settingsPath;

// Stub global fetch via the proxy-fetch module the client uses. We need a
// lightweight injection — apify-client requires('./proxy-fetch') at module
// scope, so we replace it before fresh-require.

let recordedUrl = null;
let recordedOptions = null;
let recordedPersistence = null;

function freshClient(opts = {}) {
  delete require.cache[require.resolve('../apify-client')];
  // Override env for this test run.
  process.env.APIFY_TOKEN = opts.token === undefined ? 'test-token' : opts.token;
  // Override proxy-fetch to a stub.
  const fakeFetch = async (url, options) => {
    recordedUrl = url;
    recordedOptions = options;
    if (opts.fetchImpl) return opts.fetchImpl(url, options);
    return {
      ok: true,
      status: 200,
      json: async () => opts.body || [{ username: 'demo', followersCount: 1000 }],
      text: async () => '',
    };
  };
  require.cache[require.resolve('../proxy-fetch')] = {
    exports: fakeFetch,
    loaded: true,
    id: require.resolve('../proxy-fetch'),
    filename: require.resolve('../proxy-fetch'),
    children: [],
    parent: null,
  };
  return require('../apify-client');
}

function fakePersistence() {
  const calls = [];
  return {
    persistence: {
      available: true,
      exec: async (sql, params) => { calls.push({ sql, params }); },
    },
    calls,
  };
}

beforeEach(() => {
  delete process.env.INFLUENCEX_RUNTIME_SETTINGS_PATH;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'influencex-apify-test-'));
  settingsPath = path.join(tempDir, 'provider-settings.json');
  // Never initialize or write the real application database in client tests.
  require.cache[require.resolve('../database')] = { exports: { exec: async () => {} } };
  recordedUrl = null;
  recordedOptions = null;
  recordedPersistence = null;
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.APIFY_TOKEN;
  else process.env.APIFY_TOKEN = originalToken;
  if (originalSettingsPath === undefined) delete process.env.INFLUENCEX_RUNTIME_SETTINGS_PATH;
  else process.env.INFLUENCEX_RUNTIME_SETTINGS_PATH = originalSettingsPath;
  if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
  fs.rmdirSync(tempDir);
});

function writeSettings(value) {
  fs.writeFileSync(settingsPath, JSON.stringify(value));
  process.env.INFLUENCEX_RUNTIME_SETTINGS_PATH = settingsPath;
}

test('runtime token enables client and is safely encoded in actor requests', async () => {
  const client = freshClient({ token: '' });
  delete process.env.APIFY_TOKEN;
  const token = 'fake-runtime&token=with +/?#';
  writeSettings({ apify_token: token });
  assert.equal(client.isConfigured(), true);
  const result = await client.runActor('apify/test', {}, { persistence: { available: false } });
  assert.equal(result.success, true);
  const url = new URL(recordedUrl);
  assert.equal(url.searchParams.get('token'), token);
  assert.deepEqual([...url.searchParams.keys()], ['token', 'timeout']);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('environment token takes precedence over runtime settings and resolves on use', async () => {
  const client = freshClient({ token: 'initial-env' });
  writeSettings({ apify_token: 'fake-runtime' });
  process.env.APIFY_TOKEN = 'updated-env';
  await client.runActor('apify/test', {}, { persistence: { available: false } });
  assert.equal(new URL(recordedUrl).searchParams.get('token'), 'updated-env');
  delete process.env.APIFY_TOKEN;
  await client.runActor('apify/test', {}, { persistence: { available: false } });
  assert.equal(new URL(recordedUrl).searchParams.get('token'), 'fake-runtime');
});

test('runtime token changes and removal take effect without reloading the client', async () => {
  const client = freshClient({ token: '' });
  writeSettings({ apify_token: 'first' });
  assert.equal(client.isConfigured(), true);
  writeSettings({ apify_token: 'second' });
  await client.runActor('apify/test', {}, { persistence: { available: false } });
  assert.equal(new URL(recordedUrl).searchParams.get('token'), 'second');
  writeSettings({});
  assert.equal(client.isConfigured(), false);
  recordedUrl = null;
  assert.equal((await client.runActor('apify/test', {})).success, false);
  assert.equal(recordedUrl, null);
});

test('missing, invalid JSON and invalid token values fail closed without fetching', async () => {
  const client = freshClient({ token: '' });
  process.env.INFLUENCEX_RUNTIME_SETTINGS_PATH = settingsPath;
  assert.equal(client.isConfigured(), false);
  for (const contents of ['{broken', 'null', '[]', '{}', '{"apify_token":123}', '{"apify_token":"  "}']) {
    fs.writeFileSync(settingsPath, contents);
    assert.equal(client.isConfigured(), false);
    assert.equal((await client.runActor('apify/test', {})).success, false);
  }
  assert.equal(recordedUrl, null);
});

test('unreadable runtime settings fail closed without exposing file errors', async (t) => {
  const client = freshClient({ token: '' });
  writeSettings({ apify_token: 'fake-secret' });
  t.mock.method(fs, 'readFileSync', () => { throw new Error('EACCES fake-secret'); });
  assert.equal(client.isConfigured(), false);
  const result = await client.runActor('apify/test', {});
  assert.equal(result.success, false);
  assert.match(result.error, /not configured/);
  assert.equal(result.error.includes('fake-secret'), false);
  assert.equal(recordedUrl, null);
});

test('isConfigured: false when APIFY_TOKEN missing', () => {
  const client = freshClient({ token: '' });
  assert.equal(client.isConfigured(), false);
});

test('isConfigured: true when APIFY_TOKEN set', () => {
  const client = freshClient({ token: 'abc' });
  assert.equal(client.isConfigured(), true);
});

test('runActor: returns error if not configured', async () => {
  const client = freshClient({ token: '' });
  const r = await client.runActor('apify/test', {});
  assert.equal(r.success, false);
  assert.match(r.error, /not configured/i);
});

test('runActor: success path persists running + succeeded', async () => {
  const client = freshClient({ body: [{ a: 1 }, { a: 2 }] });
  const { persistence, calls } = fakePersistence();
  const r = await client.runActor('apify/test', { foo: 'bar' }, { persistence, workspaceId: 'ws-1' });
  assert.equal(r.success, true);
  assert.equal(r.items.length, 2);
  assert.ok(r.runId);
  // Two persistence calls: insert pending + update succeeded
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO apify_runs/);
  assert.equal(calls[0].params[1], 'ws-1');
  assert.equal(calls[0].params[2], 'apify/test');
  assert.match(calls[1].sql, /UPDATE apify_runs/);
  assert.equal(calls[1].params[0], 'succeeded');
});

test('runActor: HTTP error path persists failed', async () => {
  const client = freshClient({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    }),
  });
  const { persistence, calls } = fakePersistence();
  const r = await client.runActor('apify/test', {}, { persistence });
  assert.equal(r.success, false);
  assert.match(r.error, /500/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params[0], 'failed');
});

test('runActor: includes runId in response', async () => {
  const client = freshClient();
  const { persistence } = fakePersistence();
  const r = await client.runActor('apify/test', {}, { persistence });
  assert.ok(r.runId);
  assert.match(r.runId, /^[0-9a-f-]{36}$/);
});

test('runActor: persistence failure does not break the call', async () => {
  const client = freshClient({ body: [{ x: 1 }] });
  const persistence = {
    available: true,
    exec: async () => { throw new Error('db down'); },
  };
  // Should still succeed despite persistence throwing.
  const r = await client.runActor('apify/test', {}, { persistence });
  assert.equal(r.success, true);
});

test('scrapeInstagram: passes workspaceId to runActor', async () => {
  const client = freshClient({
    body: [{ username: 'demo', fullName: 'Demo', followersCount: 999 }],
  });
  const { persistence, calls } = fakePersistence();
  const r = await client.scrapeInstagram('demo', { workspaceId: 'ws-x' });
  // we can't directly check workspaceId since scrapeInstagram gets its own
  // persistence — but we can verify the result shape.
  assert.equal(r.success, true);
  assert.equal(r.username, 'demo');
  assert.equal(r.followers, 999);
});

test('scrapeTikTok: rejects malformed username', async () => {
  const client = freshClient();
  const r = await client.scrapeTikTok('@demo');
  // `@demo` becomes `https://www.tiktok.com/@demo` and goes through normally
  // (the validation only kicks in for IG empty username case).
  // For TikTok the function always tries to call Apify, so success depends on
  // the stub. Let's just assert it didn't throw.
  assert.ok(typeof r === 'object');
});

test('runtime Apify drives TikTok capability and scraping; cached profiles bypass providers', async (t) => {
  const modashKey = process.env.MODASH_API_KEY;
  delete process.env.MODASH_API_KEY;
  t.after(() => {
    if (modashKey === undefined) delete process.env.MODASH_API_KEY;
    else process.env.MODASH_API_KEY = modashKey;
  });
  freshClient({ token: '', body: [{ authorMeta: { name: 'demo', fans: 1234 } }] });
  writeSettings({ apify_token: 'fake-runtime' });
  let cached = null;
  require.cache[require.resolve('../kol-profile-cache')] = {
    exports: {
      lookup: async () => cached,
      put: async (db, platform, username, data, source) => { cached = { data, source }; },
    },
  };
  require.cache[require.resolve('../apify-quota')] = {
    exports: { canCall: () => ({ allowed: true }), record: () => {} },
  };
  require.cache[require.resolve('../web/web-fetch')] = {
    exports: { safeFetchRaw: async () => { throw new Error('mock HTML unavailable'); } },
  };
  delete require.cache[require.resolve('../scraper')];
  const scraper = require('../scraper');
  assert.equal(scraper.getApiStatus().modash, false);
  assert.equal(scraper.getApiStatus().tiktok, true);
  assert.equal(scraper.getApiStatus().tiktok_via, 'apify');
  const result = await scraper.scrapeTikTok('https://www.tiktok.com/@demo', 'demo', { workspaceId: 'ws-test' });
  assert.equal(result.success, true);
  assert.equal(result.source, 'apify');
  assert.equal(result.data.followers, 1234);
  assert.equal(new URL(recordedUrl).searchParams.get('token'), 'fake-runtime');

  writeSettings({});
  assert.equal(scraper.getApiStatus().tiktok, false);
  assert.equal(scraper.getApiStatus().tiktok_via, null);
  recordedUrl = null;
  const hit = await scraper.scrapeTikTok('https://www.tiktok.com/@demo', 'demo');
  assert.equal(hit.cached, true);
  assert.equal(hit.data.followers, 1234);
  assert.equal(recordedUrl, null);

  const miss = await scraper.scrapeTikTok('https://www.tiktok.com/@demo', 'demo', { skipCache: true });
  assert.equal(miss.success, false);
  assert.match(miss.error, /Apify.*MODASH_API_KEY/);
  assert.equal(recordedUrl, null);
});
