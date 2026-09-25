import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import Modal from '../../components/Modal';

function compact(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return Math.round(Number(value) * 100) + '%';
}

export default function CreatorCompare({ kols, onClose }) {
  const { t } = useI18n();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const ids = useMemo(() => kols.map(k => k.id), [kols]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.compareSaivareeKols(ids)
      .then(data => { if (active) setResult(data); })
      .catch(err => { if (active) setError(err?.statusCode === 503 ? 'unavailable' : 'load'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ids]);

  const byId = new Map((result?.creators || []).map(item => [item.kol_id, item]));

  return (
    <Modal onClose={onClose} labelledBy="saivaree-compare-title" style={{ maxWidth: '1100px' }}>
      <div className="modal-header">
        <div>
          <h3 id="saivaree-compare-title" style={{ marginBottom: 3 }}>{t('kol_db.compare_title')}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('kol_db.compare_subtitle')}</div>
        </div>
        <button className="btn-icon" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>✕</button>
      </div>

      <div className="modal-body">
        {loading && <div>{t('kol_db.compare_loading')}</div>}
        {!loading && error === 'unavailable' && <div role="alert" style={{ color: 'var(--danger)' }}>{t('kol_db.analysis_unavailable')}</div>}
        {!loading && error === 'load' && <div role="alert" style={{ color: 'var(--danger)' }}>{t('kol_db.compare_error')}</div>}

        {!loading && !error && (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('kol_db.col_kol')}</th>
                  <th>{t('kol_db.analysis_median_views')}</th>
                  <th>{t('kol_db.analysis_p25_p75')}</th>
                  <th>{t('kol_db.analysis_recent_median')}</th>
                  <th>{t('kol_db.analysis_consistency')}</th>
                  <th>{t('kol_db.analysis_viral_dependency')}</th>
                  <th>{t('kol_db.analysis_views_follower')}</th>
                  <th>{t('kol_db.analysis_evidence_quality')}</th>
                </tr>
              </thead>
              <tbody>
                {kols.map(kol => {
                  const row = byId.get(kol.id);
                  const metrics = row?.observed_metrics || {};
                  const evidence = row?.evidence_quality || {};
                  const missing = !row || row.analysis_status === 'missing';
                  return (
                    <tr key={kol.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{kol.display_name || kol.username}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>@{kol.username}</div>
                      </td>
                      {missing ? (
                        <td colSpan={7} style={{ color: 'var(--text-muted)' }}>{t('kol_db.analysis_missing')}</td>
                      ) : (
                        <>
                          <td>{compact(metrics.median_views)}</td>
                          <td>{metrics.p25_views == null || metrics.p75_views == null ? '-' : compact(metrics.p25_views) + ' – ' + compact(metrics.p75_views)}</td>
                          <td>{compact(metrics.recent_weighted_median_views)}</td>
                          <td>{pct(metrics.view_consistency)}</td>
                          <td>{pct(metrics.viral_dependency)}</td>
                          <td>{metrics.views_per_follower == null ? '-' : Number(metrics.views_per_follower).toFixed(2)}</td>
                          <td>{pct(evidence.confidence_score ?? evidence.data_completeness)}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('kol_db.close')}</button>
      </div>
    </Modal>
  );
}
