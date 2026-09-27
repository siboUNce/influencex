import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    getSaivareeContactRecommendations: vi.fn(),
    prepareSaivareeOutreach: vi.fn(),
    analyzeSaivareeKol: vi.fn(),
  },
  setApiTranslator: vi.fn(),
}));

vi.mock('../../components/Toast', () => ({
  useToast: () => toastMocks,
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
    bucket: 'contact',
    contactable: true,
    reason_codes: ['campaign_fit_strong'],
    campaign_fit: { level: 'strong', matched_terms: ['skincare'], reason_codes: ['category_match'] },
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
    contact: 0,
    review: 0,
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
        selectedCampaignId={props.selectedCampaignId === undefined ? 'camp-1' : props.selectedCampaignId}
        selectedCampaign={props.selectedCampaign || { id: 'camp-1', name: 'Clinic Campaign' }}
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
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
});

describe('ContactRecommendations', () => {
  it('renders bucket counts from cached recommendations without starting Analyze', async () => {
    api.getSaivareeContactRecommendations.mockResolvedValue(result([
      row(),
      row({ kol_id: 'kol-2', username: 'review.one', bucket: 'review', contactable: false }),
      row({ kol_id: 'kol-3', username: 'data.one', bucket: 'need_more_data', contactable: false }),
    ]));

    renderPanel();

    expect((await screen.findAllByText('Creator One')).length).toBe(3);
    expect(screen.getAllByText('Contact now').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Review').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Need more data').length).toBeGreaterThan(0);
    expect(api.getSaivareeContactRecommendations).toHaveBeenCalledTimes(1);
    expect(api.getSaivareeContactRecommendations).toHaveBeenCalledWith('camp-1');
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });

  it('does not load recommendations until a campaign is selected', async () => {
    api.getSaivareeContactRecommendations.mockResolvedValue(result([row()]));

    renderPanel({ selectedCampaignId: null });

    expect(screen.getByText('Select a campaign first.')).toBeInTheDocument();
    expect(api.getSaivareeContactRecommendations).not.toHaveBeenCalled();
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });

  it('disables draft preparation when the creator has no email', async () => {
    api.getSaivareeContactRecommendations.mockResolvedValue(result([
      row({ email: '', contactable: false, reason_codes: ['missing_email'] }),
    ]));

    renderPanel({
      selectedCampaignId: 'camp-1',
      selectedCampaign: { id: 'camp-1', name: 'Clinic Campaign' },
    });

    expect(await screen.findByRole('button', { name: 'No email' })).toBeDisabled();
  });

  it('prepares one draft and reports success without sending or analyzing', async () => {
    const user = userEvent.setup();
    api.getSaivareeContactRecommendations.mockResolvedValue(result([row()]));
    api.prepareSaivareeOutreach.mockResolvedValue({
      contact_id: 'contact-1',
      created: true,
      status: 'draft',
    });

    renderPanel({
      selectedCampaignId: 'camp-1',
      selectedCampaign: { id: 'camp-1', name: 'Clinic Campaign' },
    });

    await user.click(await screen.findByRole('button', { name: 'Prepare outreach draft' }));

    expect(api.prepareSaivareeOutreach).toHaveBeenCalledTimes(1);
    expect(api.prepareSaivareeOutreach).toHaveBeenCalledWith('kol-1', 'camp-1');
    expect(toastMocks.success).toHaveBeenCalledWith('Draft ready in Contacts');
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Draft ready' })).toBeDisabled();
  });

  it.each(['review', 'need_more_data'])('opens a %s creator without auto-analyzing', async (bucket) => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    api.getSaivareeContactRecommendations.mockResolvedValue(result([
      row({ kol_id: 'kol-review', username: 'review.one', bucket, contactable: false }),
    ]));

    renderPanel({ onOpen, onClose });

    await user.click(await screen.findByRole('button', { name: 'Open' }));

    expect(onOpen).toHaveBeenCalledWith('kol-review');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });
});
