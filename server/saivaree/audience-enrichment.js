'use strict';
const crypto = require('crypto');
const { cheapScreen } = require('./cheap-screen');
const PLATFORM = 'saivaree_tiktok_audience';
const CAPS = Object.freeze({ max_posts: 3, comments_per_post: 30, max_provider_runs: 4, max_comment_items: 90 });
const TOKEN_KEY = crypto.randomBytes(32);
const TTL_MS = 7 * 86400000;
const text = v => typeof v === 'string' ? v.normalize('NFKC').toLowerCase().slice(0, 2000) : '';
const local = v => /(?:^|[^\p{L}\p{N}\p{M}])(?:บุรีรัมย์|buriram)(?=$|[^\p{L}\p{N}\p{M}])/u.test(text(v));
const sample = comments => (Array.isArray(comments) ? comments : []).filter(c => c && typeof c === 'object').slice(0, 90);
function aggregateCommercialIntent(comments) {
  const rows = sample(comments);
  const patterns = {
    price: /ราคา|เท่าไหร่|กี่บาท|\bprice\b|\bhow much\b/u,
    booking: /จอง|นัด|\bbook(?:ing)?\b|\bappointment\b/u,
    location: /ที่ไหน|พิกัด|ทำที่ไหน|\blocation\b|\bwhere\b/u,
    service_interest: /สนใจ|\binterested\b|\bclinic\b/u,
  };
  const category_counts = Object.fromEntries(Object.keys(patterns).map(k => [k, 0]));
  let count = 0;
  for (const row of rows) {
    let hit = false;
    for (const [key, pattern] of Object.entries(patterns)) {
      if (pattern.test(text(row.body))) { category_counts[key]++; hit = true; }
    }
    if (hit) count++;
  }
  const level = !rows.length ? 'insufficient' : count >= 10 && count / rows.length >= 0.2 ? 'high' : count >= 3 ? 'medium' : 'low';
  return { level, confidence: !rows.length ? 'insufficient' : rows.length >= 60 ? 'high' : rows.length >= 20 ? 'medium' : 'low',
    intent_comment_count: count, sample_count: rows.length, category_counts,
    reason_codes: [count ? 'aggregate_public_intent_patterns' : 'no_public_intent_patterns'] };
}
function analyzeAudienceEvidence(comments, postsSampled = 0) {
  const rows = sample(comments);
  const authors = new Set(), direct = new Set(), bio = new Set(), profilePosts = new Set();
  let contextual = 0;
  for (const row of rows) {
    const author = text(row.author_handle).trim().replace(/^@/, '');
    if (author) authors.add(author);
    const d = local(row.public_author_locality), b = local(row.public_author_bio);
    if (author && d) direct.add(author);
    if (author && b) bio.add(author);
    if (author && (d || b) && row.source_url) profilePosts.add(row.source_url);
    if (local(row.body)) contextual++;
  }
  const support = new Set([...direct, ...bio]).size;
  const posts = Math.min(3, Math.max(0, Number.isInteger(postsSampled) ? postsSampled : 0));
  const level = direct.size >= 3 && support >= 5 && profilePosts.size >= 2 ? 'strong'
    : direct.size || (bio.size >= 3 && profilePosts.size >= 2) ? 'moderate'
      : bio.size || contextual ? 'weak' : 'insufficient';
  const confidence = level === 'strong' && rows.length >= 30 ? 'high'
    : level === 'moderate' && support >= 3 && profilePosts.size >= 2 ? 'medium'
      : level === 'insufficient' ? 'insufficient' : 'low';
  return { level, confidence, sample_count: rows.length, unique_authors: authors.size, posts_sampled: posts,
    direct_profile_local_count: direct.size, profile_bio_local_count: bio.size, contextual_local_mentions: contextual,
    reason_codes: [...(direct.size ? ['public_locality_token'] : []), ...(bio.size ? ['public_bio_token'] : []),
      ...(contextual ? ['contextual_comment_only'] : []), ...(profilePosts.size >= 2 ? ['multiple_posts'] : []),
      ...(support >= 3 ? ['multiple_unique_authors'] : []), ...(level === 'insufficient' ? ['no_local_evidence'] : [])] };
}
function cacheKey(workspaceId, row) {
  return crypto.createHash('sha256').update(JSON.stringify([String(workspaceId), row.creator_id, String(row.username || '').trim().replace(/^@/, '').toLowerCase()])).digest('hex');
}
function planToken(workspaceId, row, now = Date.now(), key = TOKEN_KEY) {
  return crypto.createHmac('sha256', key).update(JSON.stringify([1, String(workspaceId), row.creator_id, row.username, CAPS, new Date(now).toISOString().slice(0, 10)])).digest('hex');
}
function fail(status, code) { const e = new Error(code); e.status = status; e.code = code; throw e; }
function validateBody(body, execute = false) {
  const keys = execute ? ['creator_ref', 'plan_token', 'request_id'] : ['creator_ref'];
  if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(body).length !== keys.length || keys.some(k => !Object.hasOwn(body, k))) fail(400, 'invalid_audience_request');
  if (typeof body.creator_ref !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.creator_ref)) fail(400, 'invalid_audience_request');
  if (execute && (typeof body.plan_token !== 'string' || !/^[0-9a-f]{64}$/.test(body.plan_token) || typeof body.request_id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(body.request_id))) fail(400, 'invalid_audience_request');
  return body;
}
function fresh(data, now = Date.now()) {
  if (!data || data.version !== 1 || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= now) return null;
  const b = data.buriram_audience, c = data.commercial_intent;
  if (!b || !c || !['strong','moderate','weak','insufficient'].includes(b.level) || !['high','medium','low','insufficient'].includes(c.level)) return null;
  for (const x of [b,c]) if (!['high','medium','low','insufficient'].includes(x.confidence) || !Number.isInteger(x.sample_count) || x.sample_count < 0 || x.sample_count > 90) return null;
  if (!Number.isInteger(b.posts_sampled) || b.posts_sampled < 0 || b.posts_sampled > 3 || !Number.isInteger(c.intent_comment_count) || c.intent_comment_count < 0 || c.intent_comment_count > c.sample_count) return null;
  for (const key of ['unique_authors','direct_profile_local_count','profile_bio_local_count','contextual_local_mentions']) {
    if (!Number.isInteger(b[key]) || b[key] < 0 || b[key] > b.sample_count) return null;
  }
  if (b.direct_profile_local_count > b.unique_authors || b.profile_bio_local_count > b.unique_authors) return null;
  if (!c.category_counts || ['price','booking','location','service_interest'].some(k => !Number.isInteger(c.category_counts[k]) || c.category_counts[k] < 0 || c.category_counts[k] > c.intent_comment_count)) return null;
  if (!Array.isArray(b.reason_codes) || !Array.isArray(c.reason_codes) || !Array.isArray(data.evidence_lines) || data.evidence_lines.length > 2 || data.evidence_lines.some(v => typeof v !== 'string' || v.length > 300)) return null;
  if (data.coverage !== undefined) {
    const x = data.coverage;
    if (!x || !['complete', 'partial'].includes(x.status) || !Number.isInteger(x.requested_posts) || x.requested_posts < 0 || x.requested_posts > 3
      || x.posts_sampled !== b.posts_sampled || x.posts_sampled > x.requested_posts || !Number.isInteger(x.failed_post_count)
      || x.failed_post_count < 0 || x.failed_post_count > x.requested_posts || x.posts_sampled + x.failed_post_count > x.requested_posts) return null;
    if (x.status === 'partial' && (x.posts_sampled < 1 || b.sample_count < 1)) return null;
  }
  return data;
}
async function loadCache(db, workspaceId, rows, now = Date.now()) {
  const out = new Map();
  try {
    if (!rows.length) return out;
    const keys = rows.map(row => cacheKey(workspaceId, row));
    const result = await db.query('SELECT username, profile_data, expires_at FROM kol_profile_cache WHERE platform = ? AND username IN (' + keys.map(() => '?').join(',') + ')', [PLATFORM, ...keys]);
    for (const row of result.rows || []) {
      if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now) continue;
      try { const data = fresh(JSON.parse(row.profile_data), now); if (data) out.set(row.username, data); } catch {}
    }
  } catch {}
  return out;
}
function videoUrls(items, username) {
  const out = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    for (const raw of [item?.webVideoUrl, item?.videoUrl, item?.video?.url]) {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || !['www.tiktok.com','tiktok.com'].includes(url.hostname) || url.username || url.password) continue;
        const match = url.pathname.match(/^\/@([^/]+)\/video\/(\d+)\/?$/);
        if (!match || match[1].toLowerCase() !== username.toLowerCase()) continue;
        out.add('https://www.tiktok.com/@' + username + '/video/' + match[2]);
      } catch {}
      if (out.size === 3) return [...out];
    }
  }
  return [...out];
}
function createAudienceEnrichment({ db, getRows, apify, quota, harvest, cache, now = Date.now, tokenKey = TOKEN_KEY }) {
  let busy = false;
  async function current(workspaceId, ref) {
    const rows = await getRows(workspaceId);
    const row = rows.find(r => r.creator_id === ref);
    if (!row) fail(404, 'creator_not_found');
    if (String(row.platform).toLowerCase() !== 'tiktok' || cheapScreen(row).status !== 'shortlisted') fail(409, 'creator_not_shortlisted');
    const username = String(row.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,64}$/.test(username)) fail(422, 'creator_identity_invalid');
    return { ...row, username };
  }
  async function cached(workspaceId, row) { return (await loadCache(db, workspaceId, [row], now())).get(cacheKey(workspaceId, row)); }
  async function plan(workspaceId, body) {
    validateBody(body);
    const row = await current(workspaceId, body.creator_ref);
    const q = quota.status(workspaceId);
    const scope = s => ({ runs: Math.max(0, s.runLimit - s.runs), items: Math.max(0, s.itemsLimit - s.items) });
    return { creator_ref: row.creator_id, username: row.username, ...CAPS, quota: q,
      quota_remaining: { global: scope(q), workspace: q.workspace ? scope(q.workspace) : null },
      cache_state: await cached(workspaceId, row) ? 'fresh' : 'miss', plan_token: planToken(workspaceId, row, now(), tokenKey) };
  }
  async function execute(workspaceId, body) {
    validateBody(body, true);
    const row = await current(workspaceId, body.creator_ref);
    const expected = planToken(workspaceId, row, now(), tokenKey);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(body.plan_token))) fail(409, 'stale_or_forged_plan');
    const hit = await cached(workspaceId, row);
    if (hit) return { audience_enrichment: hit, cached: true, provider_runs: [], request_id: body.request_id };
    if (busy) fail(409, 'audience_operation_in_progress');
    busy = true;
    try {
      const q = quota.status(workspaceId);
      if ([q, q.workspace].filter(Boolean).some(s => s.runLimit - s.runs < 4 || s.itemsLimit - s.items < 93)) fail(429, 'audience_quota_insufficient');
      const actor = 'clockworks/tiktok-scraper';
      const r = await apify.runActor(actor, { profiles: ['https://www.tiktok.com/@' + row.username], resultsPerPage: 3, shouldDownloadVideos: false }, { workspaceId });
      quota.record(actor, r.items?.length || 0, workspaceId);
      const runs = [{ actor_id: actor, run_id: r.runId || null, success: r.success === true }];
      if (!r.success) fail(502, 'audience_post_provider_failed');
      const urls = videoUrls(r.items, row.username);
      const h = urls.length ? await harvest({ videoUrls: urls, limitPerVideo: 30, workspaceId, strict: true }) : { success: true, comments: [], runs: [] };
      if (!h.success) fail(h.code === 'quota_exceeded' ? 429 : 502, h.code || 'audience_comment_provider_failed');
      const bounded = [];
      for (const url of urls) bounded.push(...(Array.isArray(h.comments) ? h.comments : []).filter(c => c?.source_url === url && [c.body, c.public_author_locality, c.public_author_bio].some(value => typeof value === 'string' && value.trim())).slice(0, 30));
      const postsSampled = new Set(bounded.map(c => c.source_url)).size;
      if (h.partial && !postsSampled) fail(502, 'audience_comment_provider_failed');
      const coverage = { status: h.partial ? 'partial' : 'complete', requested_posts: urls.length, posts_sampled: postsSampled,
        failed_post_count: (h.runs || []).filter(run => run.success === false).length };
      const b = analyzeAudienceEvidence(bounded, postsSampled), c = aggregateCommercialIntent(bounded);
      if (h.partial) {
        for (const aggregate of [b, c]) {
          if (aggregate.confidence === 'high') aggregate.confidence = 'medium';
          aggregate.reason_codes.push('partial_post_coverage');
        }
      }
      const data = { version: 1, analyzed_at: new Date(now()).toISOString(), expires_at: new Date(now() + TTL_MS).toISOString(),
        coverage, buriram_audience: b, commercial_intent: c, evidence_lines: [
          'Public locality: ' + b.direct_profile_local_count + '; public bio: ' + b.profile_bio_local_count + '; contextual mentions: ' + b.contextual_local_mentions,
          'Aggregate intent comments: ' + c.intent_comment_count + ' of ' + c.sample_count + (h.partial ? '; partial coverage: ' + postsSampled + '/' + urls.length + ' posts; provider stopped after failure' : ''),
        ] };
      await cache.put(db, PLATFORM, cacheKey(workspaceId, row), data, 'audience_enrichment');
      return { audience_enrichment: data, cached: false, provider_runs: [...runs, ...(h.runs || []).slice(0,3)].map(r => ({ actor_id: r.actor_id, run_id: r.run_id || null, success: r.success === true })), request_id: body.request_id };
    } finally { busy = false; }
  }
  return { plan, execute };
}
module.exports = { CAPS, PLATFORM, analyzeAudienceEvidence, aggregateCommercialIntent, planToken, validateBody, cacheKey, fresh, loadCache, videoUrls, createAudienceEnrichment };
