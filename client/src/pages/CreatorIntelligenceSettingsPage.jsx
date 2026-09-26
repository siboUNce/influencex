import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

const EMPTY = {
  discovery_provider_mode: 'fake',
  apify_live_provider_enabled: false,
  apify_token: '',
  apify_token_masked: '',
  apify_token_configured: false,
  apify_max_cost_per_run_usd: '0.50',
  apify_max_daily_cost_usd: '5.00',
  apify_budget_timezone: 'Asia/Bangkok',
  apify_run_deadline_seconds: 300,
  apify_poll_interval_seconds: 2,
  apify_discovery_keyword_actor_id: '',
  apify_discovery_hashtag_actor_id: '',
  apify_discovery_discover_actor_id: '',
  apify_discovery_expansion_actor_id: '',
  apify_creator_enrichment_actor_id: '',
};

function Field({ label, hint, children }) {
  return (
    <div className="form-group">
      <label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>{label}</label>
      {children}
      {hint && <div style={{ marginTop: 5, fontSize: 12, color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  );
}

export default function CreatorIntelligenceSettingsPage() {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api.getSaivareeSettings();
      setForm({ ...EMPTY, ...data, apify_token: '' });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }

  function set(key, value) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      const payload = {
        discovery_provider_mode: form.discovery_provider_mode,
        apify_live_provider_enabled: !!form.apify_live_provider_enabled,
        apify_max_cost_per_run_usd: String(form.apify_max_cost_per_run_usd),
        apify_max_daily_cost_usd: String(form.apify_max_daily_cost_usd),
        apify_budget_timezone: form.apify_budget_timezone,
        apify_run_deadline_seconds: Number(form.apify_run_deadline_seconds),
        apify_poll_interval_seconds: Number(form.apify_poll_interval_seconds),
        apify_discovery_keyword_actor_id: form.apify_discovery_keyword_actor_id,
        apify_discovery_hashtag_actor_id: form.apify_discovery_hashtag_actor_id,
        apify_discovery_discover_actor_id: form.apify_discovery_discover_actor_id,
        apify_discovery_expansion_actor_id: form.apify_discovery_expansion_actor_id,
        apify_creator_enrichment_actor_id: form.apify_creator_enrichment_actor_id,
      };
      if (form.apify_token.trim()) payload.apify_token = form.apify_token.trim();
      const saved = await api.updateSaivareeSettings(payload);
      setForm({ ...EMPTY, ...saved, apify_token: '' });
      toast.success('Creator Intelligence settings saved');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setLastTest(null);
    try {
      const result = await api.testSaivareeSettings();
      setLastTest({ ok: true, text: result.provider === 'apify' ? 'Apify connection OK' : 'Fake provider configuration OK' });
      toast.success('Connection test passed');
    } catch (error) {
      setLastTest({ ok: false, text: error.message });
      toast.error(error.message);
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return <div className="page-container"><div className="empty-state"><p>Loading Creator Intelligence settings…</p></div></div>;
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>Creator Intelligence Settings</h2>
          <p>Configure Saivaree Analyzer and Apify without exposing secrets to the browser.</p>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 860, marginBottom: 18 }}>
        <h3 style={{ marginBottom: 16 }}>Provider</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Provider mode">
            <select className="form-input" value={form.discovery_provider_mode} onChange={e => set('discovery_provider_mode', e.target.value)}>
              <option value="fake">Fake</option>
              <option value="apify">Apify</option>
            </select>
          </Field>
          <Field label="Live provider">
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40 }}>
              <input type="checkbox" checked={!!form.apify_live_provider_enabled} onChange={e => set('apify_live_provider_enabled', e.target.checked)} />
              <span>{form.apify_live_provider_enabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          </Field>
        </div>

        <Field
          label="Apify API token"
          hint={form.apify_token_configured ? `Saved token: ${form.apify_token_masked}. Leave blank to keep it.` : 'Token is not configured.'}
        >
          <input
            className="form-input"
            type="password"
            autoComplete="new-password"
            value={form.apify_token}
            onChange={e => set('apify_token', e.target.value)}
            placeholder={form.apify_token_configured ? 'Leave blank to keep current token' : 'apify_api_…'}
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Max cost / run (USD)">
            <input className="form-input" inputMode="decimal" value={form.apify_max_cost_per_run_usd} onChange={e => set('apify_max_cost_per_run_usd', e.target.value)} />
          </Field>
          <Field label="Daily cost cap (USD)">
            <input className="form-input" inputMode="decimal" value={form.apify_max_daily_cost_usd} onChange={e => set('apify_max_daily_cost_usd', e.target.value)} />
          </Field>
          <Field label="Run deadline (seconds)">
            <input className="form-input" type="number" min="1" max="3600" value={form.apify_run_deadline_seconds} onChange={e => set('apify_run_deadline_seconds', e.target.value)} />
          </Field>
          <Field label="Poll interval (seconds)">
            <input className="form-input" type="number" min="1" max="60" value={form.apify_poll_interval_seconds} onChange={e => set('apify_poll_interval_seconds', e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 860, marginBottom: 18 }}>
        <h3 style={{ marginBottom: 16 }}>Actor IDs</h3>
        <Field label="Keyword discovery actor">
          <input className="form-input" value={form.apify_discovery_keyword_actor_id} onChange={e => set('apify_discovery_keyword_actor_id', e.target.value)} />
        </Field>
        <Field label="Hashtag discovery actor">
          <input className="form-input" value={form.apify_discovery_hashtag_actor_id} onChange={e => set('apify_discovery_hashtag_actor_id', e.target.value)} />
        </Field>
        <Field label="Discover actor">
          <input className="form-input" value={form.apify_discovery_discover_actor_id} onChange={e => set('apify_discovery_discover_actor_id', e.target.value)} />
        </Field>
        <Field label="Expansion actor">
          <input className="form-input" value={form.apify_discovery_expansion_actor_id} onChange={e => set('apify_discovery_expansion_actor_id', e.target.value)} />
        </Field>
        <Field label="Creator enrichment actor">
          <input className="form-input" value={form.apify_creator_enrichment_actor_id} onChange={e => set('apify_creator_enrichment_actor_id', e.target.value)} />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
        <button className="btn btn-secondary" onClick={testConnection} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</button>
        {lastTest && <span style={{ fontSize: 13, color: lastTest.ok ? 'var(--success)' : 'var(--danger)' }}>{lastTest.text}</span>}
      </div>
    </div>
  );
}
