'use strict';

const crypto = require('crypto');
const { createAnalyzerClient } = require('./analyzer-client');

const CLINIC_STATUSES = new Set([
  'watching',
  'interested',
  'contacted',
  'worked_with',
  'not_selected',
]);

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
  createSaivareeHandlers,
  registerSaivareeIntelligenceRoutes,
};
