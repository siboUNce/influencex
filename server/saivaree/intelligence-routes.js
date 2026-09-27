'use strict';

const crypto = require('crypto');
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
  ['contact', 0],
  ['review', 1],
  ['need_more_data', 2],
  ['already_contacted', 3],
  ['skip', 4],
]);

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

function classifyContactRecommendation({ kol = {}, meta = {}, analysis = {} }) {
  const clinicStatus = meta?.clinic_status || 'watching';
  const clinicRating = numericOrNull(meta?.clinic_rating);
  const aiScore = numericOrNull(kol?.ai_score) ?? 0;
  const evidence = analysis?.evidence_quality || {};
  const readiness = evidence.readiness || null;
  const analysisStatus = analysis?.analysis_status || 'missing';
  const platform = String(kol?.platform || '').toLowerCase();
  const reasons = [];

  let bucket;

  if (clinicStatus === 'contacted' || clinicStatus === 'worked_with') {
    bucket = 'already_contacted';
    reasons.push(clinicStatus === 'worked_with' ? 'clinic_worked_with' : 'clinic_already_contacted');
  } else if (clinicStatus === 'not_selected' || (clinicRating !== null && clinicRating <= 2)) {
    bucket = 'skip';
    if (clinicStatus === 'not_selected') reasons.push('clinic_not_selected');
    if (clinicRating !== null && clinicRating <= 2) reasons.push('clinic_rating_low');
  } else if (platform !== 'tiktok') {
    bucket = 'need_more_data';
    reasons.push('unsupported_platform');
  } else if (analysisStatus === 'analyzer_unavailable') {
    bucket = 'need_more_data';
    reasons.push('analyzer_unavailable');
  } else if (analysisStatus !== 'available') {
    bucket = 'need_more_data';
    reasons.push('analysis_missing');
  } else if (!readiness) {
    bucket = 'need_more_data';
    reasons.push('readiness_missing');
  } else if (readiness === 'insufficient') {
    bucket = 'need_more_data';
    reasons.push('insufficient_evidence');
  } else if (readiness === 'directional' || evidence.decision_ready !== true) {
    bucket = 'review';
    reasons.push(readiness === 'directional' ? 'directional_evidence' : 'not_decision_ready');
  } else if (readiness === 'decision_grade' && evidence.decision_ready === true) {
    if (clinicStatus === 'interested') {
      bucket = 'contact';
      reasons.push('clinic_interested');
    } else if (clinicRating !== null && clinicRating >= 4) {
      bucket = 'contact';
      reasons.push('clinic_rating_strong');
    } else if (clinicRating === 3) {
      bucket = 'review';
      reasons.push('clinic_rating_neutral');
    } else if (clinicRating === null && aiScore >= 50) {
      bucket = 'contact';
      reasons.push('ai_score_fallback');
    } else {
      bucket = 'review';
      reasons.push('fit_below_threshold');
    }
  } else {
    bucket = 'review';
    reasons.push('unrecognized_readiness');
  }

  const hasEmail = typeof kol?.email === 'string' && kol.email.trim().length > 0;
  const contactable = bucket === 'contact' && hasEmail;
  if (bucket === 'contact' && !hasEmail) reasons.push('missing_email');

  return {
    bucket,
    contactable,
    reason_codes: reasons,
  };
}

function compareContactRecommendations(a, b) {
  const bucketDiff =
    (CONTACT_BUCKET_ORDER.get(a.bucket) ?? 99) -
    (CONTACT_BUCKET_ORDER.get(b.bucket) ?? 99);
  if (bucketDiff !== 0) return bucketDiff;

  if (a.bucket === 'contact' || a.bucket === 'review') {
    const interestedDiff =
      Number(b.clinic_status === 'interested') - Number(a.clinic_status === 'interested');
    if (interestedDiff !== 0) return interestedDiff;

    const aRating = numericOrNull(a.clinic_rating);
    const bRating = numericOrNull(b.clinic_rating);
    if (aRating !== bRating) {
      if (aRating === null) return 1;
      if (bRating === null) return -1;
      return bRating - aRating;
    }

    const aiDiff = compareDescNullable(a.ai_score, b.ai_score);
    if (aiDiff !== 0) return aiDiff;

    const aMetrics = a.observed_metrics || {};
    const bMetrics = b.observed_metrics || {};
    const recentDiff = compareDescNullable(
      aMetrics.recent_weighted_median_views,
      bMetrics.recent_weighted_median_views
    );
    if (recentDiff !== 0) return recentDiff;

    const consistencyDiff = compareDescNullable(
      aMetrics.view_consistency,
      bMetrics.view_consistency
    );
    if (consistencyDiff !== 0) return consistencyDiff;

    const aViral = numericOrNull(aMetrics.viral_dependency);
    const bViral = numericOrNull(bMetrics.viral_dependency);
    if (aViral !== bViral) {
      if (aViral === null) return 1;
      if (bViral === null) return -1;
      return aViral - bViral;
    }
  }

  return String(a.username || '').localeCompare(String(b.username || ''), 'en', {
    sensitivity: 'base',
  });
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
      ai_score: numericOrNull(kol.ai_score) ?? 0,
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

  async function getContactRecommendations(req, res) {
    try {
      const workspaceId = req.workspace.id;
      const result = await db.query(
        `SELECT *
         FROM kol_database
         WHERE workspace_id = ?
         ORDER BY username ASC`,
        [workspaceId]
      );

      const creators = [];
      for (const kol of result.rows || []) {
        creators.push(await buildRecommendationForKol(workspaceId, kol));
      }
      creators.sort(compareContactRecommendations);

      const summary = {
        contact: 0,
        review: 0,
        need_more_data: 0,
        already_contacted: 0,
        skip: 0,
      };
      for (const creator of creators) {
        if (Object.prototype.hasOwnProperty.call(summary, creator.bucket)) {
          summary[creator.bucket] += 1;
        }
      }

      return res.json({ summary, creators });
    } catch (_error) {
      return res.status(500).json({ error: 'Unable to load contact recommendations' });
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

      const recommendation = await buildRecommendationForKol(workspaceId, kol);
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
    `${basePath}/api/saivaree/compare`,
    rbac.requirePermission('kol.read'),
    handlers.compare
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
    getSettings: unavailable,
    updateSettings: unavailable,
    testSettings: unavailable,
  };
}

module.exports = {
  getSaivareeMeta,
  upsertSaivareeMeta,
  loadWorkspaceKol,
  classifyContactRecommendation,
  compareContactRecommendations,
  createSaivareeHandlers,
  registerSaivareeIntelligenceRoutes,
};
