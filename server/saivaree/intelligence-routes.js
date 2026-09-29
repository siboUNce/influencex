'use strict';

const crypto = require('crypto');
const { classifyBuriramRelevance } = require('./buriram-relevance');
const { createAnalyzerClient } = require('./analyzer-client');
const { renderPersonalizedEmail } = require('../agents-v2/kol-outreach');

const CLINIC_STATUSES = new Set([
  'watching',
  'interested',
  'contacted',
  'worked_with',
  'not_selected',
]);

const CONTACT_BUCKET_ORDER = new Map([
  ['eligible_for_promising_pool', 0],
  ['promising', 0],
  ['watch', 1],
  ['need_more_data', 2],
  ['already_contacted', 3],
  ['skip', 4],
]);

const CANDIDATE_TIER_ORDER = { decision_grade: 0, deep_analyzed: 1, discovery_only: 2 };

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compareDescNullable(a, b) {
  const left = numericOrNull(a);
  const right = numericOrNull(b);
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

const FIT_ORDER = { strong: 0, partial: 1, unknown: 2, none: 3 };
const TARGET_STOPWORDS = new Set('the and for with from this that your our are new best campaign clinic saivaree creator creators influencer influencers marketing promotion promote brand content official'.split(' '));

function normalizeFitText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

function evaluateCampaignFit({ campaign = {}, kol = {} }) {
  let criteria = campaign.filter_criteria || {};
  if (typeof criteria === 'string') {
    try { criteria = JSON.parse(criteria); } catch { criteria = {}; }
  }
  const categories = criteria?.categories;
  const categoryTerms = [...new Set((Array.isArray(categories) ? categories : String(categories || '').split(','))
    .map(normalizeFitText).filter(term => term.length >= 3 && !TARGET_STOPWORDS.has(term)))];
  const keywords = [...new Set(normalizeFitText(`${campaign.name || ''} ${campaign.description || ''}`)
    .split(/\s+/).filter(term => term.length >= 3 && !TARGET_STOPWORDS.has(term)))];
  let tags = kol.tags || '';
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch { /* Plain text tags are supported. */ }
  }
  const text = normalizeFitText([kol.category, kol.bio, Array.isArray(tags) ? tags.join(' ') : typeof tags === 'string' ? tags : ''].filter(Boolean).join(' '));
  // Whole words for Latin terms; Thai substrings allow unsegmented text without NLP.
  const matches = term => /[\u0E00-\u0E7F]/u.test(term)
    ? text.includes(term) : ` ${text} `.includes(` ${term} `);
  const categoryMatches = categoryTerms.filter(matches);
  const keywordMatches = keywords.filter(matches);
  const sourced = Boolean(campaign.id && kol.source_campaign_id === campaign.id);
  const level = sourced || categoryMatches.length || keywordMatches.length >= 2 ? 'strong'
    : keywordMatches.length === 1 ? 'partial'
      : categoryTerms.length || keywords.length ? 'none' : 'unknown';
  return {
    level,
    matched_terms: [...new Set([...categoryMatches, ...keywordMatches])],
    reason_codes: [
      ...(sourced ? ['source_campaign_match'] : []),
      ...(categoryMatches.length ? ['category_match'] : []),
      ...(keywordMatches.length ? ['campaign_keywords_match'] : []),
      `campaign_fit_${level}`,
    ],
  };
}

function classifyContactRecommendation({ kol = {}, meta = {}, analysis = {} }) {
  const status = meta?.clinic_status;
  const rating = numericOrNull(meta?.clinic_rating);
  const evidence = analysis?.evidence_quality || {};
  const eligibility = analysis?.eligibility || {};
  const eligible = eligibility.classification
    ? eligibility.classification === 'ELIGIBLE_INFLUENCER' : eligibility.eligible === true;
  let bucket;
  let reason;
  if (status === 'contacted' || status === 'worked_with') {
    bucket = 'already_contacted';
    reason = status === 'worked_with' ? 'clinic_worked_with' : 'clinic_already_contacted';
  } else if (status === 'not_selected' || (rating !== null && rating <= 2)) {
    bucket = 'skip';
    reason = status === 'not_selected' ? 'clinic_not_selected' : 'clinic_rating_low';
  } else if (String(kol.platform || '').toLowerCase() !== 'tiktok') {
    bucket = 'need_more_data'; reason = 'unsupported_platform';
  } else if ((eligibility.classification && !eligible) || (!eligibility.classification && eligibility.eligible === false)) {
    bucket = 'skip'; reason = 'ineligible_candidate';
  } else if (analysis?.candidate_tier === 'decision_grade') {
    bucket = 'promising'; reason = 'decision_grade';
  } else if (analysis?.candidate_tier === 'deep_analyzed') {
    bucket = 'promising'; reason = 'deep_analyzed';
  } else if (analysis?.candidate_tier === 'discovery_only') {
    bucket = eligible ? 'promising' : 'need_more_data'; reason = 'discovery_only';
  } else if (analysis?.analysis_status === 'analyzer_unavailable') {
    bucket = 'need_more_data'; reason = 'analyzer_unavailable';
  } else if (analysis?.analysis_status !== 'available') {
    bucket = 'need_more_data'; reason = 'analysis_missing';
  } else if (!evidence.readiness) {
    bucket = 'need_more_data'; reason = 'readiness_missing';
  } else if (evidence.readiness === 'insufficient') {
    bucket = 'need_more_data'; reason = 'insufficient_evidence';
  } else if (evidence.readiness === 'directional' || evidence.decision_ready !== true) {
    bucket = 'watch'; reason = evidence.readiness === 'directional' ? 'directional_evidence' : 'not_decision_ready';
  } else if (evidence.readiness === 'decision_grade') {
    bucket = 'eligible_for_promising_pool'; reason = 'decision_grade';
  } else {
    bucket = 'watch'; reason = 'unrecognized_readiness';
  }
  return { bucket, reason_codes: [reason] };
}

// Outreach remains a separate, campaign-specific decision; a global rank never authorizes a draft.
function classifyOutreachRecommendation({ kol = {}, meta = {}, analysis = {}, campaignFit = {} }) {
  // Browse tiers must not bypass the existing evidence requirements for outreach.
  const global = classifyContactRecommendation({ kol, meta, analysis: { ...analysis, candidate_tier: undefined } });
  let bucket = global.bucket === 'watch' ? 'review' : global.bucket;
  let reasons = global.reason_codes;
  if (bucket === 'eligible_for_promising_pool') {
    const level = Object.prototype.hasOwnProperty.call(FIT_ORDER, campaignFit.level) ? campaignFit.level : 'unknown';
    bucket = level === 'strong' ? 'contact' : level === 'none' ? 'skip' : 'review';
    reasons = [`campaign_fit_${level}`];
  }
  const contactable = bucket === 'contact' && typeof kol.email === 'string' && kol.email.trim().length > 0;
  if (bucket === 'contact' && !contactable) reasons = [...reasons, 'missing_email'];
  return { bucket, contactable, reason_codes: reasons };
}

function compareContactRecommendations(a, b) {
  const bucketDiff = (CONTACT_BUCKET_ORDER.get(a.bucket) ?? 99) - (CONTACT_BUCKET_ORDER.get(b.bucket) ?? 99);
  if (bucketDiff) return bucketDiff;
  if (['eligible_for_promising_pool', 'promising', 'watch'].includes(a.bucket)) {
    const tierDiff = (CANDIDATE_TIER_ORDER[a.candidate_tier] ?? 3) - (CANDIDATE_TIER_ORDER[b.candidate_tier] ?? 3);
    if (tierDiff) return tierDiff;
    if (Object.hasOwn(CANDIDATE_TIER_ORDER, a.candidate_tier)) {
      const ar = numericOrNull(a.selection_rank);
      const br = numericOrNull(b.selection_rank);
      // Missing upstream ranks sort after known ranks.
      if (ar !== br) {
        if (ar === null) return 1;
        if (br === null) return -1;
        return ar - br;
      }
    }
    if (a.bucket === 'watch') {
      const readinessOrder = { decision_grade: 0, directional: 1 };
      const diff = (readinessOrder[a.evidence_quality?.readiness] ?? 2) - (readinessOrder[b.evidence_quality?.readiness] ?? 2);
      if (diff) return diff;
    }
    const am = a.observed_metrics || {};
    const bm = b.observed_metrics || {};
    for (const [key, ascending] of [
      ['views_per_follower', false], ['view_consistency', false],
      ['viral_dependency', true], ['recent_weighted_median_views', false], ['sample_size', false],
    ]) {
      const av = numericOrNull(key === 'sample_size' ? am[key] ?? a.evidence_quality?.sample_size : am[key]);
      const bv = numericOrNull(key === 'sample_size' ? bm[key] ?? b.evidence_quality?.sample_size : bm[key]);
      if (av === bv) continue;
      if (av === null) return 1;
      if (bv === null) return -1;
      return ascending ? av - bv : bv - av;
    }
    if (a.bucket === 'watch') {
      const interested = Number(b.clinic_status === 'interested') - Number(a.clinic_status === 'interested');
      if (interested) return interested;
      const rating = compareDescNullable(a.clinic_rating, b.clinic_rating);
      if (rating) return rating;
    }
  }
  return String(a.username || '').localeCompare(String(b.username || ''), 'en', { sensitivity: 'base' });
}

async function getSaivareeMeta(db, workspaceId, kolId) {
  return db.queryOne(
    'SELECT * FROM saivaree_kol_meta WHERE workspace_id = ? AND kol_database_id = ?',
    [workspaceId, kolId]
  );
}

async function upsertSaivareeMeta(db, workspaceId, kolId, patch) {
  const current = await getSaivareeMeta(db, workspaceId, kolId);
  const next = {
    platform: patch.platform ?? current?.platform,
    username: patch.username ?? current?.username,
    saivaree_creator_id:
      patch.saivaree_creator_id ?? current?.saivaree_creator_id ?? null,
    clinic_status: patch.clinic_status ?? current?.clinic_status ?? 'watching',
    clinic_rating:
      Object.prototype.hasOwnProperty.call(patch, 'clinic_rating')
        ? patch.clinic_rating
        : current?.clinic_rating ?? null,
    clinic_notes:
      Object.prototype.hasOwnProperty.call(patch, 'clinic_notes')
        ? patch.clinic_notes
        : current?.clinic_notes ?? null,
  };

  if (!next.platform || !next.username) {
    throw new Error('platform and username are required for Saivaree metadata');
  }

  if (current) {
    await db.exec(
      `UPDATE saivaree_kol_meta
       SET platform = ?, username = ?, saivaree_creator_id = ?,
           clinic_status = ?, clinic_rating = ?, clinic_notes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = ? AND kol_database_id = ?`,
      [
        next.platform,
        next.username,
        next.saivaree_creator_id,
        next.clinic_status,
        next.clinic_rating,
        next.clinic_notes,
        workspaceId,
        kolId,
      ]
    );
  } else {
    await db.exec(
      `INSERT INTO saivaree_kol_meta
       (workspace_id, kol_database_id, platform, username, saivaree_creator_id,
        clinic_status, clinic_rating, clinic_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workspaceId,
        kolId,
        next.platform,
        next.username,
        next.saivaree_creator_id,
        next.clinic_status,
        next.clinic_rating,
        next.clinic_notes,
      ]
    );
  }

  return getSaivareeMeta(db, workspaceId, kolId);
}

async function loadWorkspaceKol(db, workspaceId, kolId) {
  return db.queryOne(
    'SELECT * FROM kol_database WHERE id = ? AND workspace_id = ?',
    [kolId, workspaceId]
  );
}

function validateMetaPatch(body) {
  const allowed = new Set(['clinic_status', 'clinic_rating', 'clinic_notes']);
  const unknown = Object.keys(body || {}).filter((key) => !allowed.has(key));
  if (unknown.length) {
    const error = new Error('unknown clinic metadata field');
    error.status = 400;
    throw error;
  }

  if (
    Object.prototype.hasOwnProperty.call(body || {}, 'clinic_status') &&
    !CLINIC_STATUSES.has(body.clinic_status)
  ) {
    const error = new Error('invalid clinic status');
    error.status = 400;
    throw error;
  }

  if (Object.prototype.hasOwnProperty.call(body || {}, 'clinic_rating')) {
    const rating = body.clinic_rating;
    if (
      rating !== null &&
      (!Number.isInteger(rating) || rating < 1 || rating > 5)
    ) {
      const error = new Error('clinic rating must be 1-5 or null');
      error.status = 400;
      throw error;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(body || {}, 'clinic_notes') &&
    body.clinic_notes !== null &&
    typeof body.clinic_notes !== 'string'
  ) {
    const error = new Error('clinic notes must be text or null');
    error.status = 400;
    throw error;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_MAX = 128;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidDeepRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'invalid_deep_analysis_request';
  return error;
}

function requireUuid(value, field) {
  if (typeof value !== 'string' || value.length > SAFE_ID_MAX || !UUID_RE.test(value)) {
    throw invalidDeepRequest(`${field} must be a UUID`);
  }
  return value;
}

function requireBoundedId(value, field) {
  if (typeof value !== 'string' || value.length > SAFE_ID_MAX || !/^[a-z0-9][a-z0-9_-]*$/i.test(value)) {
    throw invalidDeepRequest(`${field} must be a bounded identifier`);
  }
  return value;
}

function requireCreatorRefs(value, required = true) {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw invalidDeepRequest('creator_refs must contain 1-50 UUIDs');
  }
  const refs = value.map((ref) => requireUuid(ref, 'creator_refs'));
  if (new Set(refs.map(ref => ref.toLowerCase())).size !== refs.length) throw invalidDeepRequest('creator_refs must not contain duplicates');
  return refs;
}

function validateBody(body, allowed) {
  if (!isPlainObject(body)) throw invalidDeepRequest('request body must be a plain object');
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length) throw invalidDeepRequest('unknown request field');
}

function validatePlanBody(body) {
  validateBody(body, new Set(['source_run_id', 'creator_refs']));
  return { sourceRunId: requireUuid(body.source_run_id, 'source_run_id'), creatorRefs: requireCreatorRefs(body.creator_refs, false) };
}

function validateExecuteBody(body) {
  validateBody(body, new Set(['source_run_id', 'creator_refs', 'plan_token', 'request_id']));
  const refs = requireCreatorRefs(body.creator_refs, true);
  if (typeof body.plan_token !== 'string' || !/^[0-9a-f]{64}$/i.test(body.plan_token)) throw invalidDeepRequest('plan_token must be a 64-character hex token');
  if (typeof body.request_id !== 'string' || !body.request_id.trim() || body.request_id.length > SAFE_ID_MAX || /[\s\u0000-\u001f\u007f\\/?#]/u.test(body.request_id)) throw invalidDeepRequest('request_id must be a bounded non-empty string');
  return { sourceRunId: requireUuid(body.source_run_id, 'source_run_id'), creatorRefs: refs, planToken: body.plan_token, requestId: body.request_id };
}

function safeAnalyzerError(error, fallback = 'Deep analysis request failed') {
  if (error?.code === 'analyzer_unavailable') return { status: 503, body: { error: 'Analyzer unavailable', code: 'analyzer_unavailable' } };
  if ([400, 404, 409, 422, 429].includes(error?.status)) {
    const stale = error.status === 409;
    return { status: error.status, body: { error: stale ? 'Deep analysis plan is stale' : fallback, code: stale ? 'stale_plan' : 'analyzer_request_failed' } };
  }
  return { status: 500, body: { error: fallback, code: 'analyzer_request_failed' } };
}

function createSaivareeHandlers({ db, analyzer, randomUUID = crypto.randomUUID }) {
  async function resolveMapping(workspaceId, kol) {
    let meta = await getSaivareeMeta(db, workspaceId, kol.id);
    if (meta?.saivaree_creator_id) return meta;

    if (String(kol.platform || '').toLowerCase() !== 'tiktok') {
      return upsertSaivareeMeta(db, workspaceId, kol.id, {
        platform: kol.platform || 'unknown',
        username: kol.username,
        saivaree_creator_id: null,
      });
    }

    const resolved = await analyzer.resolveCreator({
      platform: kol.platform,
      username: kol.username,
    });

    meta = await upsertSaivareeMeta(db, workspaceId, kol.id, {
      platform: kol.platform,
      username: kol.username,
      saivaree_creator_id: resolved.creator_id || null,
    });
    return meta;
  }

  async function buildRecommendationForKol(workspaceId, kol) {
    let meta = await getSaivareeMeta(db, workspaceId, kol.id);
    if (!meta) {
      meta = {
        workspace_id: workspaceId,
        kol_database_id: kol.id,
        platform: kol.platform,
        username: kol.username,
        saivaree_creator_id: null,
        clinic_status: 'watching',
        clinic_rating: null,
        clinic_notes: null,
      };
    }

    let analysis = { analysis_status: 'missing' };

    if (String(kol.platform || '').toLowerCase() === 'tiktok') {
      try {
        if (!meta.saivaree_creator_id) {
          meta = await resolveMapping(workspaceId, kol);
        }
        if (meta?.saivaree_creator_id) {
          analysis = await analyzer.getAnalysis(meta.saivaree_creator_id);
        }
      } catch (_error) {
        analysis = { analysis_status: 'analyzer_unavailable' };
      }
    }

    const classification = classifyContactRecommendation({ kol, meta, analysis });

    return {
      kol_id: kol.id,
      username: kol.username,
      display_name: kol.display_name || kol.username,
      platform: kol.platform,
      email: kol.email || '',
      followers: numericOrNull(kol.followers) ?? 0,
      clinic_status: meta?.clinic_status || 'watching',
      clinic_rating: numericOrNull(meta?.clinic_rating),
      ...classification,
      analysis_status: analysis?.analysis_status || 'missing',
      observed_metrics: analysis?.observed_metrics || {},
      evidence_quality: analysis?.evidence_quality || {},
    };
  }

  async function getMeta(req, res) {
    const workspaceId = req.workspace.id;
    const kol = await loadWorkspaceKol(db, workspaceId, req.params.kolId);
    if (!kol) return res.status(404).json({ error: 'KOL not found' });

    const meta = await upsertSaivareeMeta(db, workspaceId, kol.id, {
      platform: kol.platform,
      username: kol.username,
    });
    return res.json(meta);
  }

  async function patchMeta(req, res) {
    try {
      validateMetaPatch(req.body || {});
      const workspaceId = req.workspace.id;
      const kol = await loadWorkspaceKol(db, workspaceId, req.params.kolId);
      if (!kol) return res.status(404).json({ error: 'KOL not found' });

      const meta = await upsertSaivareeMeta(db, workspaceId, kol.id, {
        platform: kol.platform,
        username: kol.username,
        ...req.body,
      });
      return res.json(meta);
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Unable to update clinic metadata',
      });
    }
  }

  async function getAnalysis(req, res) {
    try {
      const workspaceId = req.workspace.id;
      const kol = await loadWorkspaceKol(db, workspaceId, req.params.kolId);
      if (!kol) return res.status(404).json({ error: 'KOL not found' });

      const meta = await resolveMapping(workspaceId, kol);
      if (!meta.saivaree_creator_id) {
        return res.json({
          analysis_status: 'missing',
          clinic_meta: meta,
        });
      }

      const analysis = await analyzer.getAnalysis(meta.saivaree_creator_id);
      return res.json({
        ...analysis,
        clinic_meta: meta,
      });
    } catch (error) {
      if (error?.code === 'analyzer_unavailable') {
        return res.status(503).json({ analysis_status: 'analyzer_unavailable' });
      }
      return res.status(500).json({ error: 'Unable to load Saivaree analysis' });
    }
  }

  async function analyze(req, res) {
    try {
      const workspaceId = req.workspace.id;
      const kol = await loadWorkspaceKol(db, workspaceId, req.params.kolId);
      if (!kol) return res.status(404).json({ error: 'KOL not found' });

      if (String(kol.platform || '').toLowerCase() !== 'tiktok') {
        return res.status(400).json({
          error: 'TikTok platform is required before starting Creator Intelligence analysis',
          code: 'platform_required',
        });
      }

      const requestId = `${workspaceId}:${kol.id}:${randomUUID()}`;
      const result = await analyzer.analyze({
        platform: kol.platform,
        username: kol.username,
        requestId,
      });

      const meta = await upsertSaivareeMeta(db, workspaceId, kol.id, {
        platform: kol.platform,
        username: kol.username,
        saivaree_creator_id: result.creator_id,
      });

      return res.status(202).json({
        ...result,
        request_id: requestId,
        clinic_meta: meta,
      });
    } catch (error) {
      if (error?.code === 'analyzer_unavailable') {
        return res.status(503).json({ analysis_status: 'analyzer_unavailable' });
      }
      if (error?.status && error.status < 500) {
        return res.status(error.status).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Unable to start Saivaree analysis' });
    }
  }

  async function mapRecommendations(req, scan) {
      const workspaceId = req.workspace.id;
      const result = await db.query(
        `SELECT k.id, k.platform, k.username, k.email, m.clinic_status, m.clinic_rating
         FROM kol_database k
         LEFT JOIN saivaree_kol_meta m ON m.kol_database_id = k.id AND m.workspace_id = k.workspace_id
         WHERE k.workspace_id = ? ORDER BY k.id`,
        [workspaceId]
      );
      const identity = (row) => `${String(row.platform || '').trim().toLowerCase()}:${String(row.username || '').trim().replace(/^@/, '').toLowerCase()}`;
      const localByIdentity = new Map();
      for (const local of result.rows || []) {
        if (!localByIdentity.has(identity(local))) localByIdentity.set(identity(local), local);
      }
      const creators = (scan.candidates || []).map(candidate => {
        const local = localByIdentity.get(identity(candidate));
        const meta = { clinic_status: local?.clinic_status || 'watching', clinic_rating: numericOrNull(local?.clinic_rating) };
        return {
          kol_id: local?.id || null,
          creator_id: candidate.creator_id,
          platform: candidate.platform,
          username: candidate.username,
          display_name: candidate.display_name || candidate.username,
          profile_url: candidate.profile_url || '',
          avatar_url: candidate.avatar_url || '',
          followers: candidate.followers,
          email: local?.email || '',
          ...meta,
          ...classifyContactRecommendation({ kol: candidate, meta, analysis: candidate }),
          analysis_status: candidate.analysis_status,
          candidate_tier: candidate.candidate_tier,
          selection_rank: candidate.selection_rank,
          enrichment_status: candidate.enrichment_status,
          analyzed_at: candidate.analyzed_at,
          observed_metrics: candidate.observed_metrics || {},
          evidence_quality: candidate.evidence_quality || {},
          eligibility: candidate.eligibility,
          discovery_provenance: candidate.discovery_provenance,
          ...classifyBuriramRelevance(candidate),
        };
      });
      creators.sort(compareContactRecommendations);
      let rank = 0;
      for (const row of creators) {
        if (row.bucket === 'eligible_for_promising_pool') {
          row.bucket = 'promising';
          row.reason_codes = ['promising_ranked_by_creator_intelligence', 'decision_grade'];
        }
        if (row.bucket === 'promising') row.rank = ++rank;
      }
      creators.sort(compareContactRecommendations);

      const summary = {
        promising: 0,
        watch: 0,
        need_more_data: 0,
        already_contacted: 0,
        skip: 0,
      };
      for (const creator of creators) {
        if (Object.prototype.hasOwnProperty.call(summary, creator.bucket)) {
          summary[creator.bucket] += 1;
        }
      }
      return { summary, creators, scan: {
        latest_run: scan.latest_run || null,
        active_run: scan.active_run || null,
        latest_completed_run: scan.latest_completed_run || null,
        funnel: scan.funnel || scan.latest_funnel || {},
      } };
  }

  async function getContactRecommendations(req, res) {
    try {
      return res.json(await mapRecommendations(req, await analyzer.getPromisingStars()));
    } catch (_error) {
      if (_error?.code === 'analyzer_unavailable') return res.status(503).json({ error: 'Analyzer unavailable', code: 'analyzer_unavailable' });
      return res.status(500).json({ error: 'Unable to load contact recommendations' });
    }
  }

  async function refreshContactRecommendations(req, res) {
    if (Object.keys(req.body || {}).length) {
      return res.status(400).json({ error: 'Refresh accepts no settings', code: 'invalid_refresh_body' });
    }
    try {
      const requestId = `${req.workspace.id}:promising-stars:${randomUUID()}`;
      const result = await analyzer.refreshPromisingStars({ requestId });
      return res.status(202).json({ ...result, request_id: requestId });
    } catch (error) {
      if (error?.code === 'analyzer_unavailable') return res.status(503).json({ error: 'Analyzer unavailable', code: 'analyzer_unavailable' });
      if ([409, 422, 429].includes(error?.status)) {
        return res.status(error.status).json({ error: 'Candidate refresh could not be queued', code: 'refresh_rejected' });
      }
      return res.status(500).json({ error: 'Unable to refresh candidates', code: 'refresh_failed' });
    }
  }

  async function getCreatorDiscovery(req, res) {
    try {
      return res.json(await mapRecommendations(req, await analyzer.getCreatorDiscovery()));
    } catch (error) {
      const mapped = safeAnalyzerError(error, 'Unable to load creator discovery');
      return res.status(mapped.status).json(mapped.body);
    }
  }

  async function bridgeCreatorDiscovery(req, res) {
    try {
      if (!isPlainObject(req.body) || Object.keys(req.body).length) throw invalidDeepRequest('bridge accepts an empty body');
      const creatorRef = requireUuid(req.params.creatorRef, 'creator_ref');
      const scan = await analyzer.getCreatorDiscovery();
      const candidate = (scan?.candidates || []).find(row => row?.creator_id === creatorRef);
      if (!candidate) return res.status(404).json({ error: 'Creator not found', code: 'creator_not_found' });
      if (String(candidate.platform || '').toLowerCase() !== 'tiktok') return res.status(400).json({ error: 'TikTok creator required', code: 'platform_required' });
      if (candidate.candidate_tier !== 'discovery_only' || candidate.eligibility?.classification !== 'ELIGIBLE_INFLUENCER') {
        return res.status(409).json({ error: 'Creator is not eligible for analysis', code: 'creator_not_eligible' });
      }
      const username = String(candidate.username || '').trim().replace(/^@/, '').toLowerCase();
      if (!username) return res.status(422).json({ error: 'Creator identity is incomplete', code: 'creator_identity_missing' });
      if (/\s/u.test(username)) return res.status(422).json({ error: 'Creator identity is invalid', code: 'creator_identity_invalid' });
      const workspaceId = req.workspace.id;
      const identity = await db.queryOne(
        'SELECT * FROM kol_database WHERE workspace_id = ? AND LOWER(TRIM(platform)) = ? AND LOWER(TRIM(REPLACE(username, ?, ?))) = ? ORDER BY id LIMIT 1',
        [workspaceId, 'tiktok', '@', '', username]
      );
      let kol = identity;
      if (!kol) {
        const kolId = `discovery-${crypto.createHash('sha256').update(`${workspaceId}:tiktok:${username}`).digest('hex').slice(0, 40)}`;
        try {
          await db.exec(
            `INSERT INTO kol_database
             (id, workspace_id, platform, username, display_name, avatar_url, profile_url, followers, bio, scrape_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')`,
            [kolId, workspaceId, 'tiktok', username, candidate.display_name || username, candidate.avatar_url || '', candidate.profile_url || `https://www.tiktok.com/@${username}`, numericOrNull(candidate.followers) ?? 0, candidate.bio || '']
          );
          kol = { id: kolId, workspace_id: workspaceId, platform: 'tiktok', username };
        } catch (insertError) {
          // A concurrent request may have won the deterministic primary-key insert.
          kol = await db.queryOne(
            'SELECT * FROM kol_database WHERE id = ? AND workspace_id = ?',
            [kolId, workspaceId]
          );
          if (!kol) throw insertError;
        }
      }
      const meta = await getSaivareeMeta(db, workspaceId, kol.id);
      if (meta && (meta.clinic_status === 'contacted' || meta.clinic_status === 'worked_with' || meta.clinic_status === 'not_selected' || (numericOrNull(meta.clinic_rating) !== null && numericOrNull(meta.clinic_rating) <= 2))) {
        return res.status(409).json({ error: 'Creator is blocked by clinic status', code: 'creator_not_eligible' });
      }
      if (!meta || meta.saivaree_creator_id !== creatorRef) {
        await upsertSaivareeMeta(db, workspaceId, kol.id, { platform: 'tiktok', username, saivaree_creator_id: creatorRef });
      }
      return res.json({ kol_id: kol.id });
    } catch (error) {
      if (error?.code === 'invalid_deep_analysis_request') return res.status(400).json({ error: error.message, code: error.code });
      if (error?.code === 'analyzer_unavailable') return res.status(503).json({ error: 'Analyzer unavailable', code: 'analyzer_unavailable' });
      return res.status(500).json({ error: 'Unable to prepare creator analysis' });
    }
  }

  async function createDeepAnalysisPlan(req, res) {
    try {
      const body = validatePlanBody(req.body);
      const result = await analyzer.createDeepAnalysisPlan(body);
      return res.json(result);
    } catch (error) {
      if (error?.code === 'invalid_deep_analysis_request') return res.status(400).json({ error: error.message, code: error.code });
      const mapped = safeAnalyzerError(error, 'Unable to create deep analysis plan');
      return res.status(mapped.status).json(mapped.body);
    }
  }

  async function executeDeepAnalysis(req, res) {
    try {
      const body = validateExecuteBody(req.body);
      const result = await analyzer.executeDeepAnalysis(body);
      return res.status(202).json(result);
    } catch (error) {
      if (error?.code === 'invalid_deep_analysis_request') return res.status(400).json({ error: error.message, code: error.code });
      const mapped = safeAnalyzerError(error, 'Unable to execute deep analysis');
      return res.status(mapped.status).json(mapped.body);
    }
  }

  async function getDeepAnalysisJob(req, res) {
    try {
      const runId = requireBoundedId(req.params.runId, 'run_id');
      return res.json(await analyzer.getDeepAnalysisJob(runId));
    } catch (error) {
      if (error?.code === 'invalid_deep_analysis_request') return res.status(400).json({ error: error.message, code: error.code });
      const mapped = safeAnalyzerError(error, 'Unable to load deep analysis job');
      return res.status(mapped.status).json(mapped.body);
    }
  }

  async function getDeepAnalysisCreator(req, res) {
    try {
      const creatorRef = requireUuid(req.params.creatorRef, 'creator_ref');
      return res.json(await analyzer.getDeepAnalysisCreator(creatorRef));
    } catch (error) {
      if (error?.code === 'invalid_deep_analysis_request') return res.status(400).json({ error: error.message, code: error.code });
      const mapped = safeAnalyzerError(error, 'Unable to load deep analysis creator');
      return res.status(mapped.status).json(mapped.body);
    }
  }

  async function prepareOutreach(req, res) {
    try {
      const workspaceId = req.workspace.id;
      const campaignId = req.body?.campaign_id;
      if (!campaignId) {
        return res.status(400).json({
          error: 'campaign_id is required',
          code: 'campaign_required',
        });
      }

      const kol = await loadWorkspaceKol(db, workspaceId, req.params.kolId);
      if (!kol) return res.status(404).json({ error: 'KOL not found' });

      const campaign = await db.queryOne(
        'SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?',
        [campaignId, workspaceId]
      );
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found in this workspace' });
      }

      const row = await buildRecommendationForKol(workspaceId, kol);
      const recommendation = classifyOutreachRecommendation({
        kol, meta: row, analysis: row, campaignFit: evaluateCampaignFit({ campaign, kol }),
      });
      if (recommendation.bucket !== 'contact') {
        return res.status(409).json({
          error: 'Creator is not ready for outreach',
          code: 'not_contact_ready',
          bucket: recommendation.bucket,
        });
      }
      if (!recommendation.contactable) {
        return res.status(409).json({
          error: 'Creator has no email address',
          code: 'missing_email',
        });
      }

      let campaignKol = await db.queryOne(
        `SELECT *
         FROM kols
         WHERE workspace_id = ? AND campaign_id = ? AND platform = ? AND username = ?
         ORDER BY collected_at ASC
         LIMIT 1`,
        [workspaceId, campaignId, kol.platform, kol.username]
      );

      if (!campaignKol) {
        const campaignKolId = randomUUID();
        await db.exec(
          `INSERT INTO kols
           (id, workspace_id, campaign_id, platform, username, display_name, avatar_url,
            followers, engagement_rate, avg_views, category, email, profile_url, bio,
            ai_score, ai_reason, estimated_cpm, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
          [
            campaignKolId,
            workspaceId,
            campaignId,
            kol.platform,
            kol.username,
            kol.display_name || kol.username,
            kol.avatar_url || '',
            numericOrNull(kol.followers) ?? 0,
            numericOrNull(kol.engagement_rate) ?? 0,
            numericOrNull(kol.avg_views) ?? 0,
            kol.category || '',
            kol.email,
            kol.profile_url || '',
            kol.bio || '',
            numericOrNull(kol.ai_score) ?? 0,
            kol.ai_reason || '',
            numericOrNull(kol.estimated_cpm) ?? 0,
          ]
        );
        campaignKol = {
          ...kol,
          id: campaignKolId,
          workspace_id: workspaceId,
          campaign_id: campaignId,
          status: 'approved',
        };
      }

      const existing = await db.queryOne(
        `SELECT id, status
         FROM contacts
         WHERE workspace_id = ? AND campaign_id = ? AND kol_id = ?
         ORDER BY created_at ASC
         LIMIT 1`,
        [workspaceId, campaignId, campaignKol.id]
      );
      if (existing) {
        return res.json({
          contact_id: existing.id,
          created: false,
          status: existing.status,
        });
      }

      const { subject, body } = renderPersonalizedEmail({ kol: campaignKol, campaign });
      const contactId = randomUUID();
      await db.exec(
        `INSERT INTO contacts
         (id, workspace_id, kol_id, campaign_id, email_subject, email_body,
          cooperation_type, status)
         VALUES (?, ?, ?, ?, ?, ?, 'affiliate', 'draft')`,
        [contactId, workspaceId, campaignKol.id, campaignId, subject, body]
      );

      return res.status(201).json({
        contact_id: contactId,
        created: true,
        status: 'draft',
      });
    } catch (_error) {
      return res.status(500).json({ error: 'Unable to prepare outreach draft' });
    }
  }

  async function compare(req, res) {
    try {
      const ids = Array.isArray(req.body?.kol_ids) ? req.body.kol_ids : [];
      if (ids.length < 2 || ids.length > 10) {
        return res.status(400).json({ error: 'Select 2-10 creators to compare' });
      }

      const workspaceId = req.workspace.id;
      const creators = [];
      for (const kolId of ids) {
        const kol = await loadWorkspaceKol(db, workspaceId, kolId);
        if (!kol) return res.status(404).json({ error: 'KOL not found' });

        const meta = await resolveMapping(workspaceId, kol);
        if (!meta.saivaree_creator_id) {
          creators.push({
            kol_id: kol.id,
            username: kol.username,
            platform: kol.platform,
            analysis_status: 'missing',
            clinic_meta: meta,
          });
          continue;
        }

        const analysis = await analyzer.getAnalysis(meta.saivaree_creator_id);
        creators.push({
          kol_id: kol.id,
          username: kol.username,
          platform: kol.platform,
          ...analysis,
          clinic_meta: meta,
        });
      }

      return res.json({ creators });
    } catch (error) {
      if (error?.code === 'analyzer_unavailable') {
        return res.status(503).json({ analysis_status: 'analyzer_unavailable' });
      }
      return res.status(500).json({ error: 'Unable to compare creators' });
    }
  }

  return {
    getMeta,
    patchMeta,
    getAnalysis,
    analyze,
    getContactRecommendations,
    refreshContactRecommendations,
    getCreatorDiscovery,
    bridgeCreatorDiscovery,
    createDeepAnalysisPlan,
    executeDeepAnalysis,
    getDeepAnalysisJob,
    getDeepAnalysisCreator,
    prepareOutreach,
    compare,
  };
}

function registerSaivareeIntelligenceRoutes(app, {
  basePath = '',
  db,
  rbac,
  analyzer,
  platformAdmin,
}) {
  const configuredAnalyzer = analyzer || createConfiguredAnalyzer();
  const handlers = createSaivareeHandlers({ db, analyzer: configuredAnalyzer });

  app.get(
    `${basePath}/api/saivaree/kols/:kolId/meta`,
    rbac.requirePermission('kol.read'),
    handlers.getMeta
  );
  app.patch(
    `${basePath}/api/saivaree/kols/:kolId/meta`,
    rbac.requirePermission('kol.update'),
    handlers.patchMeta
  );
  app.get(
    `${basePath}/api/saivaree/kols/:kolId/analysis`,
    rbac.requirePermission('kol.read'),
    handlers.getAnalysis
  );
  app.post(
    `${basePath}/api/saivaree/kols/:kolId/analyze`,
    rbac.requirePermission('kol.update'),
    handlers.analyze
  );
  app.get(
    `${basePath}/api/saivaree/contact-recommendations`,
    rbac.requirePermission('kol.read'),
    handlers.getContactRecommendations
  );
  app.post(
    `${basePath}/api/saivaree/kols/:kolId/prepare-outreach`,
    rbac.requirePermission('contact.create'),
    handlers.prepareOutreach
  );
  app.post(
    `${basePath}/api/saivaree/contact-recommendations/refresh`,
    rbac.requirePermission('kol.update'),
    handlers.refreshContactRecommendations
  );
  app.post(
    `${basePath}/api/saivaree/compare`,
    rbac.requirePermission('kol.read'),
    handlers.compare
  );
  app.get(
    `${basePath}/api/saivaree/creator-discovery`,
    rbac.requirePermission('kol.read'),
    handlers.getCreatorDiscovery
  );
  app.post(
    `${basePath}/api/saivaree/creator-discovery/:creatorRef/kol`,
    rbac.requirePermission('kol.update'),
    handlers.bridgeCreatorDiscovery
  );
  app.post(
    `${basePath}/api/saivaree/deep-analysis/plan`,
    rbac.requirePermission('kol.read'),
    handlers.createDeepAnalysisPlan
  );
  app.post(
    `${basePath}/api/saivaree/deep-analysis/execute`,
    rbac.requirePermission('kol.update'),
    handlers.executeDeepAnalysis
  );
  app.get(
    `${basePath}/api/saivaree/deep-analysis/jobs/:runId`,
    rbac.requirePermission('kol.read'),
    handlers.getDeepAnalysisJob
  );
  app.get(
    `${basePath}/api/saivaree/deep-analysis/creators/:creatorRef`,
    rbac.requirePermission('kol.read'),
    handlers.getDeepAnalysisCreator
  );

  const adminOnly = platformAdmin || ((req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Only platform admins can perform this action' });
    next();
  });

  app.get(`${basePath}/api/saivaree/settings`, adminOnly, async (req, res) => {
    try {
      res.json(await configuredAnalyzer.getSettings());
    } catch (error) {
      if (error?.code === 'analyzer_unavailable') return res.status(503).json({ error: 'Analyzer unavailable' });
      return res.status(error?.status || 500).json({ error: error?.message || 'Unable to load settings' });
    }
  });

  app.put(`${basePath}/api/saivaree/settings`, adminOnly, async (req, res) => {
    try {
      res.json(await configuredAnalyzer.updateSettings(req.body || {}));
    } catch (error) {
      if (error?.code === 'analyzer_unavailable') return res.status(503).json({ error: 'Analyzer unavailable' });
      return res.status(error?.status || 500).json({ error: error?.message || 'Unable to update settings' });
    }
  });

  app.post(`${basePath}/api/saivaree/settings/test`, adminOnly, async (req, res) => {
    try {
      res.json(await configuredAnalyzer.testSettings());
    } catch (error) {
      if (error?.code === 'analyzer_unavailable') return res.status(503).json({ error: 'Analyzer unavailable' });
      return res.status(error?.status || 500).json({ error: error?.message || 'Unable to test settings' });
    }
  });
}

function createConfiguredAnalyzer() {
  const baseUrl = process.env.SAIVAREE_ANALYZER_BASE_URL;
  const apiKey = process.env.SAIVAREE_ANALYZER_INTERNAL_API_KEY;
  if (baseUrl && apiKey) {
    return createAnalyzerClient({
      baseUrl,
      apiKey,
      timeoutMs: parseInt(process.env.SAIVAREE_ANALYZER_TIMEOUT_MS, 10) || 8000,
    });
  }

  const unavailable = async () => {
    const error = new Error('Saivaree Analyzer is not configured');
    error.code = 'analyzer_unavailable';
    throw error;
  };
  return {
    resolveCreator: unavailable,
    getAnalysis: unavailable,
    analyze: unavailable,
    getPromisingStars: unavailable,
    refreshPromisingStars: unavailable,
    getCreatorDiscovery: unavailable,
    createDeepAnalysisPlan: unavailable,
    executeDeepAnalysis: unavailable,
    getDeepAnalysisJob: unavailable,
    getDeepAnalysisCreator: unavailable,
    getSettings: unavailable,
    updateSettings: unavailable,
    testSettings: unavailable,
  };
}

module.exports = {
  getSaivareeMeta,
  upsertSaivareeMeta,
  loadWorkspaceKol,
  evaluateCampaignFit,
  classifyContactRecommendation,
  classifyOutreachRecommendation,
  compareContactRecommendations,
  createSaivareeHandlers,
  registerSaivareeIntelligenceRoutes,
};
