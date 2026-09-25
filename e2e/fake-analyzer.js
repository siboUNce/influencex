'use strict';

const http = require('http');
const { URL } = require('url');
const { ANALYZER_INTERNAL_KEY, ANALYZER_PORT } = require('./env');

const creators = new Map([
  ['e2e.cached.creator', { id: 'creator-cached', analysis: {
    creator_id: 'creator-cached',
    analysis_status: 'available',
    analyzed_at: '2026-09-25T06:30:00Z',
    observed_metrics: {
      median_views: 12345,
      recent_weighted_median_views: 11000,
      p25_views: 8000,
      p75_views: 16000,
      sample_size: 24,
      views_per_follower: 0.42,
      viral_dependency: 0.18,
      view_consistency: 0.74,
    },
    evidence_quality: { confidence_score: 0.82, sample_size: 24 },
    risk: {},
    eligibility: {},
    operator_decision: {},
  }}],
  ['e2e.fresh.creator', { id: 'creator-fresh', analysis: null }],
]);

const state = { analyze_calls: 0, resolve_calls: 0, analysis_reads: 0 };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + ANALYZER_PORT);

  if (url.pathname === '/health') return json(res, 200, { status: 'ok' });
  if (url.pathname === '/__state') return json(res, 200, state);
  if (url.pathname === '/__reset' && req.method === 'POST') {
    state.analyze_calls = 0;
    state.resolve_calls = 0;
    state.analysis_reads = 0;
    creators.get('e2e.fresh.creator').analysis = null;
    return json(res, 200, { status: 'reset' });
  }

  if (req.headers['x-influencex-internal-key'] !== ANALYZER_INTERNAL_KEY) {
    return json(res, 401, { detail: 'internal service authentication required' });
  }

  if (req.method === 'GET' && url.pathname === '/internal/influencex/creators/resolve') {
    state.resolve_calls += 1;
    const username = normalizeUsername(url.searchParams.get('username'));
    const creator = creators.get(username);
    return json(res, 200, {
      creator_id: creator?.id || null,
      platform: 'tiktok',
      username,
      profile_url: 'https://www.tiktok.com/@' + username,
    });
  }

  const analysisMatch = url.pathname.match(/^\/internal\/influencex\/creators\/([^/]+)\/analysis$/);
  if (req.method === 'GET' && analysisMatch) {
    state.analysis_reads += 1;
    const creator = [...creators.values()].find(item => item.id === decodeURIComponent(analysisMatch[1]));
    if (!creator || !creator.analysis) return json(res, 404, { detail: 'analysis not found' });
    return json(res, 200, creator.analysis);
  }

  if (req.method === 'POST' && url.pathname === '/internal/influencex/creators/analyze') {
    state.analyze_calls += 1;
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { detail: 'invalid json' }); }
    const username = normalizeUsername(body.username);
    let creator = creators.get(username);
    if (!creator) {
      creator = { id: 'creator-' + username.replace(/[^a-z0-9]+/g, '-'), analysis: null };
      creators.set(username, creator);
    }
    creator.analysis = {
      creator_id: creator.id,
      analysis_status: 'available',
      analyzed_at: '2026-09-25T07:00:00Z',
      observed_metrics: {
        median_views: 5000,
        recent_weighted_median_views: 4800,
        p25_views: 3200,
        p75_views: 7100,
        sample_size: 20,
        views_per_follower: 0.31,
        viral_dependency: 0.12,
        view_consistency: 0.69,
      },
      evidence_quality: { confidence_score: 0.75, sample_size: 20 },
      risk: {},
      eligibility: {},
      operator_decision: {},
    };
    return json(res, 202, {
      creator_id: creator.id,
      username,
      run_id: 'fake-run-' + state.analyze_calls,
      status: 'queued',
    });
  }

  return json(res, 404, { detail: 'not found' });
});

server.listen(ANALYZER_PORT, '127.0.0.1', () => {
  process.stdout.write('fake-analyzer listening on ' + ANALYZER_PORT + '\n');
});
