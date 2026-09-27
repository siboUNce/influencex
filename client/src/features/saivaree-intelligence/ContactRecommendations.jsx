import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useToast } from '../../components/Toast';
import Modal from '../../components/Modal';

const BUCKETS = ['contact', 'review', 'need_more_data', 'already_contacted', 'skip'];

function compact(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function scorePercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return Math.round(Number(value)) + '%';
}

function ratioPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return Math.round(Number(value) * 100) + '%';
}

export default function ContactRecommendations({
  selectedCampaignId,
  selectedCampaign,
  onOpen,
  onClose,
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [preparingId, setPreparingId] = useState(null);
  const [preparedIds, setPreparedIds] = useState(() => new Set());

  useEffect(() => {
    let active = true;
    setData(null);
    setPreparedIds(new Set());
    setError(false);
    if (!selectedCampaignId) { setLoading(false); return; }
    setLoading(true);
    api.getSaivareeContactRecommendations(selectedCampaignId)
      .then((result) => {
        if (active) {
          setData(result);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [selectedCampaignId]);

  async function prepareDraft(row) {
    if (!selectedCampaignId || !row.contactable || preparingId) return;
    setPreparingId(row.kol_id);
    try {
      await api.prepareSaivareeOutreach(row.kol_id, selectedCampaignId);
      setPreparedIds((current) => new Set(current).add(row.kol_id));
      toast.success(t('kol_db.contact_rec_draft_ready'));
    } catch (err) {
      toast.error(err?.message || t('kol_db.contact_rec_prepare_error'));
    } finally {
      setPreparingId(null);
    }
  }

  function openCreator(row) {
    onOpen?.(row.kol_id);
    onClose?.();
  }

  const summary = data?.summary || {};
  const creators = data?.creators || [];
  const contactRanks = new Map(creators.filter(row => row.bucket === 'contact').map((row, index) => [row.kol_id, index + 1]));

  return (
    <Modal onClose={onClose} labelledBy="contact-recommendations-title" style={{ maxWidth: '1180px' }}>
      <div className="modal-header">
        <div>
          <h3 id="contact-recommendations-title" style={{ marginBottom: 3 }}>
            {t('kol_db.contact_rec_title')}{selectedCampaignId ? ` — ${selectedCampaign?.name || selectedCampaignId}` : ''}
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('kol_db.contact_rec_subtitle')}
          </div>
        </div>
        <button className="btn-icon" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
          ✕
        </button>
      </div>

      <div className="modal-body">
        {selectedCampaignId ? (
          <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            {t('kol_db.contact_rec_campaign', { name: selectedCampaign?.name || selectedCampaignId })}
          </div>
        ) : (
          <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--warning)' }}>
            {t('kol_db.contact_rec_select_campaign')}
          </div>
        )}

        {selectedCampaignId && loading && <div>{t('kol_db.contact_rec_loading')}</div>}
        {selectedCampaignId && !loading && error && (
          <div role="alert" style={{ color: 'var(--danger)' }}>{t('kol_db.contact_rec_error')}</div>
        )}

        {selectedCampaignId && !loading && !error && (
          <>
            <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
              {BUCKETS.map((bucket) => (
                <div className="stat-card" key={bucket} style={{ minHeight: 72 }}>
                  <div>
                    <div className="stat-value" style={{ fontSize: 20 }}>{summary[bucket] || 0}</div>
                    <div className="stat-label">{t(`kol_db.contact_rec_bucket_${bucket}`)}</div>
                  </div>
                </div>
              ))}
            </div>

            {creators.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>{t('kol_db.contact_rec_empty')}</div>
            ) : (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>{t('kol_db.col_kol')}</th>
                      <th>{t('kol_db.contact_rec_col_status')}</th>
                      <th>{t('kol_db.contact_rec_col_evidence')}</th>
                      <th>{t('kol_db.contact_rec_col_fit')}</th>
                      <th>{t('kol_db.analysis_recent_median')}</th>
                      <th>{t('kol_db.analysis_consistency')}</th>
                      <th>{t('kol_db.analysis_viral_dependency')}</th>
                      <th>{t('kol_db.analysis_views_follower')}</th>
                      <th>{t('kol_db.detail_email')}</th>
                      <th>{t('kol_db.contact_rec_col_action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creators.map((row) => {
                      const metrics = row.observed_metrics || {};
                      const evidence = row.evidence_quality || {};
                      const sampleSize = metrics.sample_size ?? evidence.sample_size;
                      const prepared = preparedIds.has(row.kol_id);
                      const missingEmail = row.bucket === 'contact' && !row.contactable;
                      const noCampaign = row.bucket === 'contact' && !selectedCampaignId;
                      return (
                        <tr key={row.kol_id}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{contactRanks.has(row.kol_id) && <span>#{contactRanks.get(row.kol_id)} </span>}{row.display_name || row.username}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>@{row.username}</div>
                          </td>
                          <td>
                            <span className={
                              row.bucket === 'contact' ? 'badge badge-green'
                                : row.bucket === 'review' ? 'badge badge-orange'
                                  : row.bucket === 'skip' ? 'badge badge-red'
                                    : 'badge'
                            }>
                              {t(`kol_db.contact_rec_bucket_${row.bucket}`)}
                            </span>
                            {row.reason_codes?.[0] && (
                              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                                {t(`kol_db.contact_rec_reason_${row.reason_codes[0]}`)}
                              </div>
                            )}
                          </td>
                          <td>
                            <div>{sampleSize == null ? '-' : t('kol_db.contact_rec_sample', { count: sampleSize })}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              {evidence.readiness ? t(`kol_db.contact_rec_readiness_${evidence.readiness}`) : '-'}
                            </div>
                          </td>
                          <td>
                            <div>{t(`kol_db.contact_rec_fit_${row.campaign_fit?.level || 'unknown'}`)}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{row.campaign_fit?.matched_terms?.slice(0, 3).join(', ')}</div>
                            {row.campaign_fit?.reason_codes?.includes('source_campaign_match') && <div style={{ fontSize: 12 }}>{t('kol_db.contact_rec_source_match')}</div>}
                          </td>
                          <td>{compact(metrics.recent_weighted_median_views)}</td>
                          <td>{scorePercent(metrics.view_consistency)}</td>
                          <td>{ratioPercent(metrics.viral_dependency)}</td>
                          <td>{metrics.views_per_follower == null ? '-' : Number(metrics.views_per_follower).toFixed(4)}</td>
                          <td>{row.email || t('kol_db.contact_rec_no_email')}</td>
                          <td>
                            {row.bucket === 'contact' ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                onClick={() => prepareDraft(row)}
                                disabled={preparingId === row.kol_id || prepared || missingEmail || noCampaign}
                              >
                                {prepared
                                  ? t('kol_db.contact_rec_draft_ready_short')
                                  : missingEmail
                                    ? t('kol_db.contact_rec_no_email')
                                    : noCampaign
                                      ? t('kol_db.contact_rec_select_campaign_short')
                                      : preparingId === row.kol_id
                                        ? t('kol_db.contact_rec_preparing')
                                        : t('kol_db.contact_rec_prepare')}
                              </button>
                            ) : (row.bucket === 'review' || row.bucket === 'need_more_data') ? (
                              <button type="button" className="btn btn-sm btn-secondary" onClick={() => openCreator(row)}>
                                {t('kol_db.contact_rec_open')}
                              </button>
                            ) : (
                              <span style={{ color: 'var(--text-muted)' }}>-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('kol_db.close')}</button>
      </div>
    </Modal>
  );
}
