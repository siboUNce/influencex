import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import Modal from '../../components/Modal';

const rowId = row => row.kol_id || row.creator_id || `${row.platform}:${row.username}`;
const isActive = run => ['queued', 'running'].includes(run?.status);
const safeProfile = value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};

const BUCKETS = ['promising', 'watch', 'need_more_data', 'already_contacted', 'skip'];
const CANDIDATE_TIERS = ['decision_grade', 'deep_analyzed', 'discovery_only'];

function candidateTier(row) {
  if (CANDIDATE_TIERS.includes(row.candidate_tier)) return row.candidate_tier;
  return null;
}

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
  onOpen,
  onClose,
}) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [waitingForScan, setWaitingForScan] = useState(false);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [pollStopped, setPollStopped] = useState(false);
  const mounted = useRef(false);
  const posting = useRef(false);
  const pendingScan = useRef(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    let timer;
    let polls = 0;
    setPollStopped(false);
    function pollAgain() {
      if (++polls < 100) timer = setTimeout(load, 3000);
      else {
        pendingScan.current = null;
        setWaitingForScan(false);
        setPollStopped(true);
      }
    }
    async function load() {
      try {
        const result = await api.getSaivareeContactRecommendations();
        if (!active) return;
        setData(result);
        setError(false);
        const pending = pendingScan.current;
        if (pending) {
          const runs = [result.scan?.active_run, result.scan?.latest_run, result.scan?.latest_completed_run];
          const observed = runs.find(run => run?.id && (pending.id
            ? run.id === pending.id : !pending.previousIds.includes(run.id)));
          if (observed && ['completed', 'failed', 'cancelled'].includes(observed.status)) {
            pendingScan.current = null;
          }
        }
        setWaitingForScan(Boolean(pendingScan.current));
        if (pendingScan.current || isActive(result.scan?.active_run)) pollAgain();
      } catch {
        if (active) {
          setError(true);
          if (pendingScan.current) pollAgain();
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; clearTimeout(timer); };
  }, [pollEpoch]);

  async function refresh() {
    if (posting.current || pendingScan.current || loading || waitingForScan || isActive(data?.scan?.active_run)) return;
    posting.current = true;
    setRefreshing(true);
    try {
      const run = await api.refreshSaivareeContactRecommendations();
      if (!mounted.current) return;
      pendingScan.current = {
        id: run?.id,
        previousIds: [data?.scan?.active_run?.id, data?.scan?.latest_run?.id, data?.scan?.latest_completed_run?.id].filter(Boolean),
      };
      setWaitingForScan(true);
      setPollEpoch(epoch => epoch + 1);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      posting.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }

  function openCreator(row) {
    if (row.kol_id) {
      onOpen?.(row.kol_id);
      onClose?.();
    } else {
      const profile = safeProfile(row.profile_url);
      if (profile) window.open(profile, '_blank', 'noopener,noreferrer');
    }
  }

  const summary = data?.summary || {};
  const creators = data?.creators || [];
  const promisingRanks = new Map(creators.filter(row => row.bucket === 'promising').map((row, index) => [rowId(row), index + 1]));

  return (
    <Modal onClose={onClose} labelledBy="contact-recommendations-title" style={{ maxWidth: '1180px' }}>
      <div className="modal-header">
        <div>
          <h3 id="contact-recommendations-title" style={{ marginBottom: 3 }}>
            {t('kol_db.contact_rec_title')}
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
        <button type="button" className="btn btn-primary" onClick={refresh}
          disabled={loading || refreshing || waitingForScan || isActive(data?.scan?.active_run)}>
          {t('kol_db.contact_rec_refresh')}
        </button>
        <div role="status" style={{ margin: '10px 0', fontSize: 13 }}>
          {t('kol_db.contact_rec_scan_status', { status: t(`kol_db.contact_rec_scan_${
            refreshing || (waitingForScan && !isActive(data?.scan?.active_run)) ? 'queued' :
              ['queued', 'running', 'completed', 'failed', 'cancelled'].includes((data?.scan?.active_run || data?.scan?.latest_run)?.status)
                ? (data.scan.active_run || data.scan.latest_run).status : 'idle'
          }`) })}
          {data?.scan?.latest_completed_run?.finished_at && <div>{t('kol_db.contact_rec_completed_at', { time: new Date(data.scan.latest_completed_run.finished_at).toLocaleString() })}</div>}
        </div>
        {pollStopped && <div>{t('kol_db.contact_rec_poll_stopped')}</div>}
        {data?.scan && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 14 }}>
          {['unique_discovered', 'eligible_candidates', 'selected_pool', 'analyzed_pool', 'decision_grade_count'].map(key => (
            <span key={key}>{t(`kol_db.contact_rec_funnel_${key}`)}: {data.scan.funnel?.[key] ?? '-'}</span>
          ))}
        </div>}
        {loading && <div>{t('kol_db.contact_rec_loading')}</div>}
        {!loading && error && (
          <div role="alert" style={{ color: 'var(--danger)' }}>{t('kol_db.contact_rec_error')}</div>
        )}

        {!loading && data && (
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
                      const tier = candidateTier(row);
                      const sampleSize = metrics.sample_size ?? evidence.sample_size;
                      return (
                        <tr key={rowId(row)}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{promisingRanks.has(rowId(row)) && <span>#{promisingRanks.get(rowId(row))} </span>}{row.display_name || row.username}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>@{row.username}</div>
                          </td>
                          <td>
                            <span className={
                              row.bucket === 'promising' ? 'badge badge-green'
                                : row.bucket === 'watch' ? 'badge badge-orange'
                                  : row.bucket === 'skip' ? 'badge badge-red'
                                    : 'badge'
                            }>
                              {t(`kol_db.contact_rec_bucket_${row.bucket}`)}
                            </span>
                            {tier && <span className={`badge ${tier === 'decision_grade' ? 'badge-green' : tier === 'deep_analyzed' ? 'badge-orange' : ''}`} style={{ marginLeft: 4 }}>
                              {t(`kol_db.contact_rec_tier_${tier}`)}
                            </span>}
                            {row.reason_codes?.[0] && (
                              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                                {t(`kol_db.contact_rec_reason_${row.reason_codes[0]}`)}
                              </div>
                            )}
                          </td>
                          <td>
                            <div>{sampleSize == null ? '-' : t('kol_db.contact_rec_sample', { count: sampleSize })}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              {tier === 'discovery_only' ? '-' : evidence.readiness ? t(`kol_db.contact_rec_readiness_${evidence.readiness}`) : '-'}
                            </div>
                          </td>
                          <td>{compact(metrics.recent_weighted_median_views)}</td>
                          <td>{scorePercent(metrics.view_consistency)}</td>
                          <td>{ratioPercent(metrics.viral_dependency)}</td>
                          <td>{metrics.views_per_follower == null ? '-' : Number(metrics.views_per_follower).toFixed(4)}</td>
                          <td>{row.email || t('kol_db.contact_rec_no_email')}</td>
                          <td>
                            <button type="button" className="btn btn-sm btn-secondary" disabled={!row.kol_id && !safeProfile(row.profile_url)} onClick={() => openCreator(row)}>
                              {t('kol_db.contact_rec_open')}
                            </button>
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
