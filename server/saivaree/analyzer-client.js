'use strict';

class AnalyzerUnavailableError extends Error {
  constructor(message = 'Saivaree Analyzer is unavailable') {
    super(message);
    this.name = 'AnalyzerUnavailableError';
    this.code = 'analyzer_unavailable';
  }
}

function createAnalyzerClient({
  baseUrl,
  apiKey,
  timeoutMs = 8000,
  fetchImpl = global.fetch,
}) {
  if (!baseUrl) throw new Error('SAIVAREE_ANALYZER_BASE_URL is required');
  if (!apiKey) throw new Error('SAIVAREE_ANALYZER_INTERNAL_API_KEY is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const root = String(baseUrl).replace(/\/$/, '');

  async function call(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(root + path, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-InfluenceX-Internal-Key': apiKey,
          ...(options.headers || {}),
        },
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      return { response, payload };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AnalyzerUnavailableError('Saivaree Analyzer request timed out');
      }
      throw new AnalyzerUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  async function requireOk(path, options, { safeErrors = false } = {}) {
    const { response, payload } = await call(path, options);
    if (!response.ok) {
      if (response.status >= 500) throw new AnalyzerUnavailableError();
      const error = new Error(safeErrors ? 'Saivaree Analyzer request failed' : (payload?.detail || 'Saivaree Analyzer request failed'));
      error.code = safeErrors && response.status === 409 ? 'stale_plan' : 'analyzer_request_failed';
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  return {
    async resolveCreator({ platform, username }) {
      const query = new URLSearchParams({
        platform: String(platform || ''),
        username: String(username || ''),
      });
      return requireOk('/internal/influencex/creators/resolve?' + query.toString());
    },

    async getAnalysis(creatorId) {
      const path = '/internal/influencex/creators/' +
        encodeURIComponent(String(creatorId)) +
        '/analysis';
      const { response, payload } = await call(path);
      if (response.status === 404) return { analysis_status: 'missing' };
      if (response.status >= 500) throw new AnalyzerUnavailableError();
      if (!response.ok) {
        const error = new Error(payload?.detail || 'Saivaree Analyzer request failed');
        error.code = 'analyzer_request_failed';
        error.status = response.status;
        throw error;
      }
      return payload;
    },

    async analyze({ platform, username, requestId }) {
      return requireOk('/internal/influencex/creators/analyze', {
        method: 'POST',
        body: JSON.stringify({
          platform,
          username,
          request_id: requestId,
        }),
      });
    },

    async getPromisingStars() {
      return requireOk('/internal/influencex/promising-stars');
    },

    async refreshPromisingStars({ requestId }) {
      return requireOk('/internal/influencex/promising-stars/refresh', {
        method: 'POST', body: JSON.stringify({ request_id: requestId }),
      });
    },

    async getCreatorDiscovery() {
      try {
        return await requireOk('/internal/influencex/creator-discovery', undefined, { safeErrors: true });
      } catch (error) {
        // Older Analyzer releases expose the same cached browse data under this name.
        if (error.status !== 404) throw error;
        return requireOk('/internal/influencex/promising-stars', undefined, { safeErrors: true });
      }
    },

    async createDeepAnalysisPlan({ sourceRunId, creatorRefs } = {}) {
      const body = { source_run_id: sourceRunId };
      if (creatorRefs !== undefined) body.creator_refs = creatorRefs;
      return requireOk('/internal/influencex/deep-analysis/plan', {
        method: 'POST', body: JSON.stringify(body),
      }, { safeErrors: true });
    },

    async executeDeepAnalysis({ sourceRunId, creatorRefs, planToken, requestId } = {}) {
      return requireOk('/internal/influencex/deep-analysis/execute', {
        method: 'POST',
        body: JSON.stringify({ source_run_id: sourceRunId, creator_refs: creatorRefs, plan_token: planToken, request_id: requestId }),
      }, { safeErrors: true });
    },

    async getDeepAnalysisJob(runId) {
      return requireOk('/internal/influencex/deep-analysis/jobs/' + encodeURIComponent(String(runId)), undefined, { safeErrors: true });
    },

    async getDeepAnalysisCreator(creatorRef) {
      return requireOk('/internal/influencex/deep-analysis/creators/' + encodeURIComponent(String(creatorRef)), undefined, { safeErrors: true });
    },

    async getSettings() {
      return requireOk('/internal/influencex/settings');
    },

    async updateSettings(patch) {
      return requireOk('/internal/influencex/settings', {
        method: 'PUT',
        body: JSON.stringify(patch || {}),
      });
    },

    async testSettings() {
      return requireOk('/internal/influencex/settings/test', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
  };
}

module.exports = {
  AnalyzerUnavailableError,
  createAnalyzerClient,
};
