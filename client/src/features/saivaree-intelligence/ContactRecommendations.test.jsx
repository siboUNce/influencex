import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/client', () => ({
  api: {
    getSaivareeContactRecommendations: vi.fn(),
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
  return { summary, creators };
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
  api.prepareSaivareeOutreach.mockReset();
  api.analyzeSaivareeKol.mockReset();
});

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
    expect(await screen.findByText('No creators to review yet.')).toBeInTheDocument();
  });

  it('shows a load failure without starting paid work', async () => {
    api.getSaivareeContactRecommendations.mockRejectedValue(new Error('unavailable'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load contact recommendations');
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });
});
