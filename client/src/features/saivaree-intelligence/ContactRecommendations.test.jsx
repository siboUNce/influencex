import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/client', () => ({
  api: {
    getSaivareeContactRecommendations: vi.fn(),
    refreshSaivareeContactRecommendations: vi.fn(),
    prepareSaivareeOutreach: vi.fn(),
    analyzeSaivareeKol: vi.fn(),
  },
  setApiTranslator: vi.fn(),
}));

import { api } from '../../api/client';
import { I18nProvider } from '../../i18n';
import ContactRecommendations from './ContactRecommendations';

function row(overrides = {}) {
  return {
    kol_id: 'kol-1',
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
  return { summary, creators, scan: { active_run: null, latest_run: { status: 'completed' }, latest_completed_run: { finished_at: '2026-09-28T00:00:00Z' }, funnel: { unique_discovered: 300, eligible_candidates: 50, selected_pool: 30, analyzed_pool: 28, decision_grade_count: 20 } } };
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
  api.getSaivareeContactRecommendations.mockReset();
  api.refreshSaivareeContactRecommendations.mockReset();
  api.prepareSaivareeOutreach.mockReset();
  api.analyzeSaivareeKol.mockReset();
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ContactRecommendations', () => {
  it('loads a global cached shortlist once without a campaign and shows ranks and raw metrics', async () => {
    api.getSaivareeContactRecommendations.mockResolvedValue(result([
      row(), row({ kol_id: 'kol-2', username: 'watch.one', bucket: 'watch' }),
      row({ kol_id: 'kol-3', username: 'data.one', bucket: 'need_more_data' }),
    ]));
    renderPanel();
    await screen.findByText('@creator.one');
    expect(screen.getByRole('heading', { name: 'Promising stars' })).toBeInTheDocument();
    for (const label of ['Promising', 'Watch', 'Need more data']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getAllByText('0.5000')).toHaveLength(3);
    expect(screen.queryByText('Campaign fit')).not.toBeInTheDocument();
    expect(screen.queryByText(/AI (score|70)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Select a campaign/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prepare outreach/i })).not.toBeInTheDocument();
    expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(1);
    expect(api.getSaivareeContactRecommendations).toHaveBeenCalledWith();
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
    api.getSaivareeContactRecommendations.mockResolvedValue(result([row({ bucket, email: '' })]));
    renderPanel({ onOpen, onClose });
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('kol-1');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.prepareSaivareeOutreach).not.toHaveBeenCalled();
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });

  it('shows an empty shortlist when no cached candidates exist', async () => {
    api.getSaivareeContactRecommendations.mockResolvedValue(result([]));
    renderPanel();
    expect(await screen.findByText('No cached candidates yet. Refresh candidates to discover new creators.')).toBeInTheDocument();
  });

  it('shows a load failure without starting paid work', async () => {
    api.getSaivareeContactRecommendations.mockRejectedValue(new Error('unavailable'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load or refresh candidates.');
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });
});

it('opens newly discovered profiles safely with unique ranks and never opens a local detail', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  api.getSaivareeContactRecommendations.mockResolvedValue(result([
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
      username: `creator-${index + 1}`,
      display_name: `Creator ${index + 1}`,
      candidate_tier,
      evidence_quality: {
        readiness: candidate_tier === 'deep_analyzed' ? 'directional' : 'decision_grade',
        decision_ready: candidate_tier === 'decision_grade',
      },
    });
  });
  api.getSaivareeContactRecommendations.mockResolvedValue(result(creators));

  renderPanel();
  await screen.findByText('@creator-1');

  expect(screen.getAllByText('Decision-grade')).toHaveLength(4);
  expect(screen.getAllByText('Deep analyzed')).toHaveLength(2);
  expect(screen.getAllByText('Discovery only')).toHaveLength(44);
  expect(screen.getAllByText('Decision grade')).toHaveLength(4);
  expect(screen.getByText('#1')).toBeInTheDocument();
  expect(screen.getByText('#50')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(50);
  expect(screen.queryByRole('button', { name: /Prepare outreach/i })).not.toBeInTheDocument();
  expect(api.prepareSaivareeOutreach).not.toHaveBeenCalled();
  expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
});

it('rejects unsafe external profile URLs', async () => {
  api.getSaivareeContactRecommendations.mockResolvedValue(result([row({ kol_id: null, creator_id: 'unsafe', profile_url: 'javascript:alert(1)' })]));
  renderPanel();
  expect(await screen.findByRole('button', { name: 'Open' })).toBeDisabled();
});

it('refresh click POSTs once, retains completed candidates, and polls only GET until terminal', async () => {
  vi.useFakeTimers();
  const completed = result([row()]);
  completed.scan.latest_run = { id: 'run', status: 'completed' };
  const running = { ...completed, scan: { ...completed.scan, active_run: { id: 'run', status: 'running' } } };
  api.getSaivareeContactRecommendations.mockResolvedValueOnce(completed).mockResolvedValueOnce(running).mockResolvedValueOnce(completed);
  api.refreshSaivareeContactRecommendations.mockResolvedValue({ status: 'queued', id: 'run' });
  await act(async () => { renderPanel(); });
  const button = screen.getByRole('button', { name: 'Refresh candidates (uses Apify)' });
  await act(async () => { fireEvent.click(button); fireEvent.click(button); });
  expect(api.refreshSaivareeContactRecommendations).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  expect(screen.getByText('@creator.one')).toBeInTheDocument();
  expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(3);
  expect(button).toBeEnabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(3);
  expect(api.refreshSaivareeContactRecommendations).toHaveBeenCalledTimes(1);
  expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
});

it('keeps refresh locked through delayed scan visibility and only polls GET after one POST', async () => {
  vi.useFakeTimers();
  const old = result([row()]);
  old.scan.latest_run = { id: 'old-run', status: 'completed' };
  const running = { ...old, scan: { ...old.scan, active_run: { id: 'new-run', status: 'running' } } };
  const completed = { ...old, scan: { ...old.scan, latest_run: { id: 'new-run', status: 'completed' } } };
  api.getSaivareeContactRecommendations.mockResolvedValueOnce(old)
    .mockResolvedValueOnce(old).mockResolvedValueOnce(old)
    .mockResolvedValueOnce(running).mockResolvedValue(completed);
  api.refreshSaivareeContactRecommendations.mockResolvedValue({ id: 'new-run', status: 'queued' });
  await act(async () => { renderPanel(); });
  const button = screen.getByRole('button', { name: 'Refresh candidates (uses Apify)' });
  await act(async () => { fireEvent.click(button); });
  expect(button).toBeDisabled();
  for (let step = 0; step < 2; step += 1) {
    await act(async () => { fireEvent.click(button); await vi.advanceTimersByTimeAsync(3000); });
    expect(button).toBeDisabled();
    expect(screen.getByText('@creator.one')).toBeInTheDocument();
  }
  expect(screen.getByRole('status')).toHaveTextContent('Running');
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(button).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('Completed');
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(5);
  expect(api.refreshSaivareeContactRecommendations).toHaveBeenCalledTimes(1);
  expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
});

it('unlocks after bounded polling when an accepted scan never becomes visible', async () => {
  vi.useFakeTimers();
  api.getSaivareeContactRecommendations.mockResolvedValue(result([row()]));
  api.refreshSaivareeContactRecommendations.mockResolvedValue({ id: 'delayed', status: 'queued' });
  await act(async () => { renderPanel(); });
  const button = screen.getByRole('button', { name: 'Refresh candidates (uses Apify)' });
  await act(async () => { fireEvent.click(button); });
  expect(button).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(330000); });
  expect(button).toBeEnabled();
  expect(screen.getByText(/Status polling paused/)).toBeInTheDocument();
  expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(101);
  expect(api.refreshSaivareeContactRecommendations).toHaveBeenCalledTimes(1);
});

it('observes an existing active scan without POST and stops polling on unmount', async () => {
  vi.useFakeTimers();
  const data = result([]);
  data.scan.active_run = { status: 'queued' };
  api.getSaivareeContactRecommendations.mockResolvedValue(data);
  let view;
  await act(async () => { view = renderPanel(); });
  expect(screen.getByRole('button', { name: 'Refresh candidates (uses Apify)' })).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(2);
  expect(api.refreshSaivareeContactRecommendations).not.toHaveBeenCalled();
});

it('bounds status polling without ever reposting', async () => {
  vi.useFakeTimers();
  const data = result([]);
  data.scan.active_run = { status: 'running' };
  api.getSaivareeContactRecommendations.mockResolvedValue(data);
  await act(async () => { renderPanel(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(330000); });
  expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(100);
  expect(screen.getByText(/Status polling paused/)).toBeInTheDocument();
  expect(api.refreshSaivareeContactRecommendations).not.toHaveBeenCalled();
});
