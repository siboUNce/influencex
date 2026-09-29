import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/client', () => ({
  api: {
    getSaivareeCreatorDiscovery: vi.fn(),
    planSaivareeDeepAnalysis: vi.fn(),
    executeSaivareeDeepAnalysis: vi.fn(),
    getSaivareeDeepAnalysisJob: vi.fn(),
    getSaivareeDeepAnalysisCreator: vi.fn(),
    refreshSaivareeContactRecommendations: vi.fn(),
    prepareSaivareeOutreach: vi.fn(),
    analyzeSaivareeKol: vi.fn(),
    ensureSaivareeDiscoveryKol: vi.fn(),
  },
  setApiTranslator: vi.fn(),
}));

import { api } from '../../api/client';
import { I18nProvider } from '../../i18n';
import ContactRecommendations from './ContactRecommendations';

function row(overrides = {}) {
  return {
    kol_id: 'kol-1',
    creator_id: '00000000-0000-4000-8000-000000000001',
    username: 'creator.one',
    display_name: 'Creator One',
    platform: 'tiktok',
    email: 'creator@example.com',
    followers: 10000,
    ai_score: 70,
    clinic_status: 'watching',
    clinic_rating: 4,
    bucket: 'promising',
    contactable: true,
    reason_codes: ['promising_ranked_by_creator_intelligence'],
    analysis_status: 'available',
    observed_metrics: {
      sample_size: 20,
      recent_weighted_median_views: 5000,
      view_consistency: 75,
      viral_dependency: 0.2,
      views_per_follower: 0.5,
    },
    evidence_quality: {
      readiness: 'decision_grade',
      decision_ready: true,
    },
    ...overrides,
  };
}

function result(creators) {
  const summary = {
    promising: 0,
    watch: 0,
    need_more_data: 0,
    already_contacted: 0,
    skip: 0,
  };
  for (const creator of creators) summary[creator.bucket] += 1;
  return { summary, creators, scan: { active_run: null, latest_run: { status: 'completed' }, latest_completed_run: { id: '10000000-0000-4000-8000-000000000001', finished_at: '2026-09-28T00:00:00Z' }, funnel: { unique_discovered: 300, eligible_candidates: 50, selected_pool: 30, analyzed_pool: 28, decision_grade_count: 20 } } };
}

function renderPanel(props = {}) {
  return render(
    <I18nProvider>
      <ContactRecommendations
        onOpen={props.onOpen || vi.fn()}
        onClose={props.onClose || vi.fn()}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  api.getSaivareeCreatorDiscovery.mockReset();
  api.planSaivareeDeepAnalysis.mockReset();
  api.executeSaivareeDeepAnalysis.mockReset();
  api.getSaivareeDeepAnalysisJob.mockReset();
  api.getSaivareeDeepAnalysisCreator.mockReset();
  api.refreshSaivareeContactRecommendations.mockReset();
  api.prepareSaivareeOutreach.mockReset();
  api.analyzeSaivareeKol.mockReset();
  api.ensureSaivareeDiscoveryKol.mockReset();
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ContactRecommendations', () => {
  it('loads a global cached shortlist once without a campaign and shows ranks and raw metrics', async () => {
    api.getSaivareeCreatorDiscovery.mockResolvedValue(result([
      row(), row({ kol_id: 'kol-2', username: 'watch.one', bucket: 'watch' }),
      row({ kol_id: 'kol-3', username: 'data.one', bucket: 'need_more_data' }),
    ]));
    renderPanel();
    await screen.findByText('@creator.one');
    expect(screen.getByRole('heading', { name: 'Creator Discovery' })).toBeInTheDocument();
    for (const label of ['Promising', 'Watch', 'Need more data']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getAllByText('0.5000')).toHaveLength(3);
    expect(screen.queryByText('Campaign fit')).not.toBeInTheDocument();
    expect(screen.queryByText(/AI (score|70)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Select a campaign/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prepare outreach/i })).not.toBeInTheDocument();
    expect(api.getSaivareeCreatorDiscovery).toHaveBeenCalledTimes(1);
    expect(api.getSaivareeCreatorDiscovery).toHaveBeenCalledWith();
    expect(api.refreshSaivareeContactRecommendations).not.toHaveBeenCalled();
    expect(screen.getByText('Discovered: 300')).toBeInTheDocument();
    expect(screen.getByText('Decision-grade: 20')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Completed');
    expect(screen.getByText(/Last completed scan:/)).toBeInTheDocument();
    expect(api.prepareSaivareeOutreach).not.toHaveBeenCalled();
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });

  it.each(['promising', 'watch', 'need_more_data', 'already_contacted', 'skip'])('opens a %s creator even without email, without drafting or analyzing', async bucket => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    api.getSaivareeCreatorDiscovery.mockResolvedValue(result([row({ bucket, email: '' })]));
    renderPanel({ onOpen, onClose });
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('kol-1');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.prepareSaivareeOutreach).not.toHaveBeenCalled();
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });

  it('shows an empty shortlist when no cached candidates exist', async () => {
    api.getSaivareeCreatorDiscovery.mockResolvedValue(result([]));
    renderPanel();
    expect(await screen.findByText('No cached candidates yet.')).toBeInTheDocument();
  });

  it('shows a load failure without starting paid work', async () => {
    api.getSaivareeCreatorDiscovery.mockRejectedValue(new Error('unavailable'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load cached creators.');
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });
});

it('opens newly discovered profiles safely with unique ranks and never opens a local detail', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([
    row({ kol_id: null, creator_id: 'new-1', profile_url: 'https://www.tiktok.com/@new1' }),
    row({ kol_id: null, creator_id: 'new-2', profile_url: 'https://www.tiktok.com/@new2' }),
  ]));
  renderPanel({ onOpen, onClose });
  const buttons = await screen.findAllByRole('button', { name: 'Open' });
  expect(screen.getByText('#1')).toBeInTheDocument();
  expect(screen.getByText('#2')).toBeInTheDocument();
  await user.click(buttons[1]);
  expect(open).toHaveBeenCalledWith('https://www.tiktok.com/@new2', '_blank', 'noopener,noreferrer');
  expect(onOpen).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('renders tier badges and ranks a 50-row shortlist without starting paid actions', async () => {
  const creators = Array.from({ length: 50 }, (_, index) => {
    const candidate_tier = index < 4 ? 'decision_grade' : index < 6 ? 'deep_analyzed' : 'discovery_only';
    return row({
      kol_id: `kol-${index + 1}`,
      creator_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      username: `creator-${index + 1}`,
      display_name: `Creator ${index + 1}`,
      candidate_tier,
      evidence_quality: {
        readiness: candidate_tier === 'deep_analyzed' ? 'directional' : 'decision_grade',
        decision_ready: candidate_tier === 'decision_grade',
      },
    });
  });
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result(creators));

  renderPanel();
  await screen.findByText('@creator-1');

  expect(screen.getAllByText('Decision Grade')).toHaveLength(4);
  expect(screen.getAllByText('Deep Analyzed')).toHaveLength(2);
  expect(screen.getAllByText('Discovery Only')).toHaveLength(44);
  expect(screen.getAllByText('Decision grade')).toHaveLength(4);
  expect(screen.getByText('#1')).toBeInTheDocument();
  expect(screen.getByText('#50')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(50);
  expect(screen.queryByRole('button', { name: /Prepare outreach/i })).not.toBeInTheDocument();
  expect(api.prepareSaivareeOutreach).not.toHaveBeenCalled();
  expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
});

it('rejects unsafe external profile URLs', async () => {
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([row({ kol_id: null, creator_id: 'unsafe', profile_url: 'javascript:alert(1)' })]));
  renderPanel();
  expect(await screen.findByRole('button', { name: 'Open' })).toBeDisabled();
});


const discovery = overrides => row({ candidate_tier: 'discovery_only', enrichment_status: 'discovery_only', ...overrides });

it('groups both sections on one screen and only offers discovery analysis', async () => {
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([
    row({ candidate_tier: 'decision_grade', username: 'best' }),
    row({ kol_id: 'kol-2', candidate_tier: 'deep_analyzed', username: 'deep' }),
    discovery({ kol_id: 'kol-3', username: 'new' }),
  ]));
  renderPanel();
  const top = await screen.findByRole('region', { name: 'Top Picks (2)' });
  expect(within(top).getByText('@best')).toBeInTheDocument();
  expect(within(top).getByText('@deep')).toBeInTheDocument();
  expect(within(top).queryByRole('button', { name: 'Deep Analyze' })).not.toBeInTheDocument();
  const promising = screen.getByRole('region', { name: 'Promising Creators (1)' });
  expect(within(promising).getByText('@new')).toBeInTheDocument();
  expect(within(promising).getByRole('button', { name: 'Deep Analyze' })).toBeEnabled();
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  expect(screen.getByText(/may incur provider cost/)).toBeInTheDocument();
});

it('uses existing single-KOL analysis once and refreshes tiers after success', async () => {
  api.getSaivareeCreatorDiscovery.mockResolvedValueOnce(result([discovery()]))
    .mockResolvedValue(result([row({ candidate_tier: 'decision_grade' })]));
  let finish;
  api.analyzeSaivareeKol.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  renderPanel();
  const button = await screen.findByRole('button', { name: 'Deep Analyze' });
  fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveTextContent('Submitting');
  expect(api.analyzeSaivareeKol).toHaveBeenCalledExactlyOnceWith('kol-1');
  await act(async () => finish({ status: 'queued' }));
  expect(await screen.findByText('Analysis complete. Results updated.')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Top Picks (1)' })).toHaveTextContent('@creator.one');
  expect(api.getSaivareeCreatorDiscovery).toHaveBeenCalledTimes(2);
  expect(api.ensureSaivareeDiscoveryKol).not.toHaveBeenCalled();
  expect(api.refreshSaivareeContactRecommendations).not.toHaveBeenCalled();
  expect(api.prepareSaivareeOutreach).not.toHaveBeenCalled();
  expect(api.executeSaivareeDeepAnalysis).not.toHaveBeenCalled();
});

it('resolves an unsaved creator before using the existing analysis route', async () => {
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([discovery({ kol_id: null })]));
  api.ensureSaivareeDiscoveryKol.mockResolvedValue({ kol_id: 'saved-kol' });
  api.analyzeSaivareeKol.mockResolvedValue({ status: 'queued' });
  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Deep Analyze' }));
  await screen.findByText('Analysis requested. Waiting for updated results.');
  expect(api.ensureSaivareeDiscoveryKol).toHaveBeenCalledExactlyOnceWith(row().creator_id);
  expect(api.analyzeSaivareeKol).toHaveBeenCalledExactlyOnceWith('saved-kol');
  expect(api.getSaivareeCreatorDiscovery).toHaveBeenCalledTimes(2);
});

it.each(['bridge', 'analysis'])('surfaces %s errors without automatic retry or discovery refresh', async failure => {
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([discovery({ kol_id: failure === 'bridge' ? null : 'kol-1' })]));
  api.ensureSaivareeDiscoveryKol.mockRejectedValue(new Error('failed'));
  api.analyzeSaivareeKol.mockRejectedValue(new Error('failed'));
  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Deep Analyze' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to complete analysis');
  expect(api.analyzeSaivareeKol).toHaveBeenCalledTimes(failure === 'bridge' ? 0 : 1);
  expect(api.getSaivareeCreatorDiscovery).toHaveBeenCalledTimes(1);
  expect(api.refreshSaivareeContactRecommendations).not.toHaveBeenCalled();
});

it('does not start analysis after unmount during identity resolution', async () => {
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([discovery({ kol_id: null })]));
  let resolve;
  api.ensureSaivareeDiscoveryKol.mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Deep Analyze' }));
  view.unmount();
  await act(async () => resolve({ kol_id: 'saved-kol' }));
  expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
});

it('polls cached results while queued and cleans up without repeating paid work', async () => {
  vi.useFakeTimers();
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([discovery()]));
  api.analyzeSaivareeKol.mockResolvedValue({ status: 'queued' });
  let view;
  await act(async () => { view = renderPanel(); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Deep Analyze' })));
  expect(screen.getByRole('button', { name: 'Deep Analyze' })).toBeDisabled();
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.getSaivareeCreatorDiscovery).toHaveBeenCalledTimes(3);
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(12000));
  expect(api.getSaivareeCreatorDiscovery).toHaveBeenCalledTimes(3);
  expect(api.analyzeSaivareeKol).toHaveBeenCalledTimes(1);
  expect(api.refreshSaivareeContactRecommendations).not.toHaveBeenCalled();
});

it.each(['already_contacted', 'skip'])('does not offer analysis for %s rows', async bucket => {
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([discovery({ bucket })]));
  renderPanel();
  await screen.findByText('@creator.one');
  expect(screen.queryByRole('button', { name: 'Deep Analyze' })).not.toBeInTheDocument();
});

it.each(['failed', 'skipped_budget'])('shows terminal %s and stops polling without retry', async enrichment_status => {
  vi.useFakeTimers();
  api.getSaivareeCreatorDiscovery.mockResolvedValueOnce(result([discovery()]))
    .mockResolvedValue(result([discovery({ enrichment_status })]));
  api.analyzeSaivareeKol.mockResolvedValue({ status: 'queued' });
  await act(async () => renderPanel());
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Deep Analyze' })));
  expect(screen.getByRole('alert')).toHaveTextContent('Unable to complete analysis');
  expect(screen.getByText(enrichment_status === 'failed' ? 'Failed' : 'Skipped: budget')).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(api.getSaivareeCreatorDiscovery).toHaveBeenCalledTimes(2);
  expect(api.analyzeSaivareeKol).toHaveBeenCalledTimes(1);
});

it('keeps other discovery rows actionable while one row is submitting', async () => {
  api.getSaivareeCreatorDiscovery.mockResolvedValue(result([
    discovery(), discovery({ kol_id: 'kol-2', creator_id: '00000000-0000-4000-8000-000000000002' }),
  ]));
  api.analyzeSaivareeKol.mockImplementation(() => new Promise(() => {}));
  renderPanel();
  const buttons = await screen.findAllByRole('button', { name: 'Deep Analyze' });
  fireEvent.click(buttons[0]);
  expect(buttons[0]).toBeDisabled();
  expect(buttons[1]).toBeEnabled();
});
