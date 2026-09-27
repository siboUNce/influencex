import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

const READINESS = {
  decision_grade: {
    labelKey: 'kol_db.analysis_readiness_decision_grade',
    descriptionKey: 'kol_db.analysis_readiness_decision_grade_body',
    color: 'var(--success)',
  },
  directional: {
    labelKey: 'kol_db.analysis_readiness_directional',
    descriptionKey: 'kol_db.analysis_readiness_directional_body',
    color: 'var(--warning)',
  },
  insufficient: {
    labelKey: 'kol_db.analysis_readiness_insufficient',
    descriptionKey: 'kol_db.analysis_readiness_insufficient_body',
    color: 'var(--danger)',
  },
};

const READINESS_UNAVAILABLE = {
  labelKey: 'kol_db.analysis_readiness_unavailable',
  descriptionKey: 'kol_db.analysis_readiness_unavailable_body',
  color: 'var(--text-primary)',
};

function formatCompact(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function formatRatioPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return Math.round(Number(value) * 100) + '%';
}

function formatScorePercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return Math.round(Number(value)) + '%';
}

function formatViewsPerFollower(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  if (Math.abs(n) < 0.01 && n !== 0) return n.toFixed(4);
  return n.toFixed(2);
}

function Metric({ label, value }) {
  return (
    <div className="stat-card" style={{ minHeight: 82 }}>
      <div>
        <div className="stat-value" style={{ fontSize: 18 }}>{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

export default function AnalysisPanel({ kol }) {
  const { t } = useI18n();
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState(null);

  const supportedPlatform = String(kol.platform || '').toLowerCase() === 'tiktok';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (!supportedPlatform) {
      setAnalysis({ analysis_status: 'unsupported_platform' });
      setLoading(false);
      return;
    }
    try {
      const result = await api.getSaivareeAnalysis(kol.id);
      setAnalysis(result);
    } catch (err) {
      if (err?.statusCode === 503) setError('unavailable');
      else setError('load');
    } finally {
      setLoading(false);
    }
  }, [kol.id, supportedPlatform]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAnalyze() {
    setRunning(true);
    setQueued(false);
    setError(null);
    try {
      await api.analyzeSaivareeKol(kol.id);
      setQueued(true);
    } catch (err) {
      if (err?.statusCode === 429) setQueued(true);
      else if (err?.statusCode === 503) setError('unavailable');
      else setError('run');
    } finally {
      setRunning(false);
    }
  }

  const status = analysis?.analysis_status;
  const metrics = analysis?.observed_metrics || {};
  const evidence = analysis?.evidence_quality || {};
  const hasAnalysis = status === 'available';
  const readiness = READINESS[evidence.readiness] ?? READINESS_UNAVAILABLE;
  const sampleSize = metrics.sample_size ?? evidence.sample_size;

  return (
    <section
      aria-label={t('kol_db.analysis_title')}
      style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <h4 style={{ margin: 0, fontSize: 15 }}>{t('kol_db.analysis_title')}</h4>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            {t('kol_db.analysis_subtitle')}
          </div>
        </div>
        <button type="button" className="btn btn-sm btn-primary" onClick={handleAnalyze} disabled={running || queued || !supportedPlatform}>
          {running
            ? t('kol_db.analysis_running')
            : hasAnalysis
              ? t('kol_db.analysis_reanalyze')
              : t('kol_db.analysis_analyze')}
        </button>
      </div>

      {loading && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('kol_db.analysis_loading')}</div>}

      {!loading && error === 'unavailable' && (
        <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
          {t('kol_db.analysis_unavailable')}
        </div>
      )}

      {!loading && error && error !== 'unavailable' && (
        <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
          {error === 'run' ? t('kol_db.analysis_run_error') : t('kol_db.analysis_load_error')}
        </div>
      )}

      {!loading && !error && status === 'unsupported_platform' && (
        <div style={{ fontSize: 13, color: 'var(--warning)' }}>
          Select TikTok as the platform before using Creator Intelligence.
        </div>
      )}

      {!loading && !error && status === 'missing' && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('kol_db.analysis_missing')}</div>
      )}

      {queued && (
        <div role="status" style={{ marginTop: 10, padding: '9px 12px', borderRadius: 6, background: 'var(--accent-light)', fontSize: 13 }}>
          {t('kol_db.analysis_queued')}{' '}
          <button type="button" className="btn btn-sm btn-secondary" onClick={load} style={{ marginLeft: 8 }}>
            {t('kol_db.analysis_refresh')}
          </button>
        </div>
      )}

      {!loading && !error && hasAnalysis && (
        <div role="note" aria-label={t('kol_db.analysis_readiness_label')} style={{ marginTop: 12, padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-secondary)', fontSize: 13, lineHeight: 1.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px 12px', flexWrap: 'wrap' }}>
            <strong style={{ color: readiness.color }}>{t(readiness.labelKey)}</strong>
            {sampleSize != null && <span>{t('kol_db.analysis_sample_target', { count: sampleSize })}</span>}
          </div>
          <div>{t(readiness.descriptionKey)}</div>
        </div>
      )}

      {!loading && !error && hasAnalysis && (
        <>
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginTop: 12 }}>
            <Metric label={t('kol_db.analysis_median_views')} value={formatCompact(metrics.median_views)} />
            <Metric label={t('kol_db.analysis_recent_median')} value={formatCompact(metrics.recent_weighted_median_views)} />
            <Metric
              label={t('kol_db.analysis_p25_p75')}
              value={metrics.p25_views == null || metrics.p75_views == null
                ? '-'
                : formatCompact(metrics.p25_views) + ' – ' + formatCompact(metrics.p75_views)}
            />
            <Metric label={t('kol_db.analysis_consistency')} value={formatScorePercent(metrics.view_consistency)} />
            <Metric label={t('kol_db.analysis_viral_dependency')} value={formatRatioPercent(metrics.viral_dependency)} />
            <Metric
              label={t('kol_db.analysis_views_follower')}
              value={formatViewsPerFollower(metrics.views_per_follower)}
            />
            <Metric
              label={t('kol_db.analysis_evidence_quality')}
              value={evidence.confidence_score != null
                ? formatScorePercent(evidence.confidence_score)
                : formatRatioPercent(evidence.data_completeness)}
            />
            <Metric
              label={t('kol_db.analysis_sample_size')}
              value={formatCompact(metrics.sample_size ?? evidence.sample_size)}
            />
          </div>

          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span>
              Sample window: {evidence.sample_window_days ? evidence.sample_window_days + ' days' : '-'}
            </span>
            <span>
              Confidence: {evidence.confidence_grade ? String(evidence.confidence_grade).toUpperCase() : '-'}
            </span>
            <span>
              {t('kol_db.analysis_last_updated')}{' '}
              {analysis.analyzed_at ? new Date(analysis.analyzed_at).toLocaleString() : '-'}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
