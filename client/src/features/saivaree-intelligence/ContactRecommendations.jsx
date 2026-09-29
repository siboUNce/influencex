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
const DEEP_STATES = ['queued', 'running', 'deep_analyzed', 'decision_grade', 'failed', 'skipped_budget'];
const creatorKey = row => row.creator_id || row.kol_id || rowId(row);
const buriramRelevance = row => ['strong', 'related'].includes(row.buriram_relevance) ? row.buriram_relevance : 'none';
const buriramSignals = row => Array.isArray(row.buriram_signals) ? row.buriram_signals.slice(0, 2) : [];

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

  const [pollEpoch, setPollEpoch] = useState(0);
  const [pollStopped, setPollStopped] = useState(false);
  const [rowActions, setRowActions] = useState({});
  const [buriramOnly, setBuriramOnly] = useState(false);
  const mounted = useRef(false);
  const submitting = useRef(new Set());
  const pending = useRef(new Set());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    let timer;
    let polls = 0;
    setPollStopped(false);
    function pollAgain() {
      if (++polls < 100) timer = setTimeout(load, 3000);
      else {
        setPollStopped(true);
      }
    }
    async function load() {
      try {
        const result = await api.getSaivareeCreatorDiscovery();
        if (!active) return;
        setData(result);
        for (const row of result.creators || []) {
          const key = creatorKey(row);
          if (pending.current.has(key) && ['deep_analyzed', 'decision_grade'].includes(row.candidate_tier)) {
            pending.current.delete(key);
            setRowActions(previous => ({ ...previous, [key]: 'success' }));
          } else if (pending.current.has(key) && ['failed', 'skipped_budget'].includes(row.enrichment_status)) {
            pending.current.delete(key);
            setRowActions(previous => ({ ...previous, [key]: 'error' }));
          }
        }
        setError(false);
        if (isActive(result.scan?.active_run) || pending.current.size) pollAgain();
      } catch {
        if (active) {
          setError(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; clearTimeout(timer); };
  }, [pollEpoch]);

  async function analyzeCreator(row) {
    const key = creatorKey(row);
    if (submitting.current.has(key) || pending.current.has(key)) return;
    submitting.current.add(key);
    setRowActions(previous => ({ ...previous, [key]: 'submitting' }));
    try {
      let kolId = row.kol_id;
      if (!kolId) {
        const resolved = await api.ensureSaivareeDiscoveryKol(row.creator_id);
        kolId = resolved.kol_id;
        if (!mounted.current) return;
        if (!kolId) throw new Error('Missing KOL identity');
      }
      await api.analyzeSaivareeKol(kolId);
      if (!mounted.current) return;
      pending.current.add(key);
      setRowActions(previous => ({ ...previous, [key]: 'queued' }));
      setPollEpoch(epoch => epoch + 1);
    } catch {
      if (mounted.current) setRowActions(previous => ({ ...previous, [key]: 'error' }));
    } finally {
      submitting.current.delete(key);
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
  const visibleCreators = buriramOnly ? creators.filter(row => ['strong', 'related'].includes(row.buriram_relevance)) : creators;
  const sections = [
    { id: 'top', rows: visibleCreators.filter(row => ['decision_grade', 'deep_analyzed'].includes(row.candidate_tier)) },
    { id: 'promising', rows: visibleCreators.filter(row => row.candidate_tier === 'discovery_only') },
  ];
  const legacyRows = visibleCreators.filter(row => !CANDIDATE_TIERS.includes(row.candidate_tier));
  if (creators.some(row => !CANDIDATE_TIERS.includes(row.candidate_tier))) sections.push({ id: 'other', rows: legacyRows });
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
        <button type="button" className="btn btn-secondary" onClick={() => setPollEpoch(epoch => epoch + 1)} disabled={loading}>
          {t('kol_db.discovery_reload')}
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 12, fontSize: 13 }}>
          <input type="checkbox" checked={buriramOnly} onChange={event => setBuriramOnly(event.target.checked)} />
          {t('kol_db.discovery_buriram_only')}
        </label>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('kol_db.discovery_analysis_cost')}</p>
        <div role="status" style={{ margin: '10px 0', fontSize: 13 }}>
          {t('kol_db.contact_rec_scan_status', { status: t(`kol_db.contact_rec_scan_${
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
          <div>
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

            {creators.length === 0 && <p>{t('kol_db.contact_rec_empty')}</p>}
            {sections.map(section => <section key={section.id} aria-labelledby={`discovery-${section.id}`} style={{ marginTop: 20 }}>
              <h4 id={`discovery-${section.id}`} style={{ marginBottom: 4 }}>{t(`kol_db.discovery_section_${section.id}`)} ({section.rows.length})</h4>
              <p style={{ marginTop: 0, fontSize: 12, color: 'var(--text-muted)' }}>{t(`kol_db.discovery_section_${section.id}_body`)}</p>
              {section.rows.length === 0 ? <p>{t(buriramOnly ? 'kol_db.buriram_filter_empty' : `kol_db.discovery_section_${section.id}_empty`)}</p> : (
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
                    {section.rows.map((row) => {
                      const metrics = row.observed_metrics || {};
                      const evidence = row.evidence_quality || {};
                      const tier = candidateTier(row);
                      const state = row.enrichment_status;
                      const action = rowActions[creatorKey(row)];
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
                            {DEEP_STATES.includes(state) && !CANDIDATE_TIERS.includes(state) && <div style={{ marginTop: 4 }}>
                              <span className={`badge ${state === 'failed' ? 'badge-red' : 'badge-orange'}`}>{t(`kol_db.deep_state_${state}`)}</span>
                            </div>}
                            {row.reason_codes?.[0] && (
                              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                                {t('kol_db.contact_rec_reason_' + row.reason_codes[0])}
                              </div>
                            )}
                            <div style={{ marginTop: 4 }}>
                              <span className={'badge ' + (buriramRelevance(row) === 'strong' ? 'badge-green' : buriramRelevance(row) === 'related' ? 'badge-orange' : '')}>
                                {t('kol_db.buriram_relevance_' + buriramRelevance(row))}
                              </span>
                              {buriramSignals(row).map((signal, index) => (
                                <div key={(signal.code || 'signal') + '-' + index} style={{ marginTop: 2, fontSize: 11, color: 'var(--text-muted)' }}>
                                  {t('kol_db.buriram_signal_' + signal.code)}{signal.snippet ? ' (' + signal.snippet + ')' : ''}
                                </div>
                              ))}
                            </div>
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
                            {tier === 'discovery_only' && !['skip', 'already_contacted'].includes(row.bucket) && row.platform === 'tiktok' && <button
                              type="button" className="btn btn-sm btn-secondary" onClick={() => analyzeCreator(row)}
                              disabled={['submitting', 'queued'].includes(action) || ['queued', 'running'].includes(state) || (!row.kol_id && !row.creator_id)} style={{ marginRight: 4 }}>
                              {t(action === 'submitting' ? 'kol_db.discovery_analyzing' : 'kol_db.deep_analyze')}
                            </button>}
                            {action && <div role={action === 'error' ? 'alert' : 'status'} style={{ marginTop: 4, fontSize: 12 }}>
                              {t(`kol_db.discovery_action_${action}`)}
                            </div>}
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
            </section>)}
          </div>
        )}
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose}>{t('kol_db.close')}</button>
      </div>
    </Modal>
  );
}
