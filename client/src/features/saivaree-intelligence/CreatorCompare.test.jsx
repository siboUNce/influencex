import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../api/client', () => ({
  api: {
    compareSaivareeKols: vi.fn(),
    analyzeSaivareeKol: vi.fn(),
  },
  setApiTranslator: vi.fn(),
}));

import { api } from '../../api/client';
import { I18nProvider } from '../../i18n';
import CreatorCompare from './CreatorCompare';

const KOLS = [
  { id: 'kol-a', username: 'creator.a', display_name: 'Creator A', platform: 'tiktok' },
  { id: 'kol-b', username: 'creator.b', display_name: 'Creator B', platform: 'tiktok' },
];

function renderCompare() {
  return render(
    <I18nProvider>
      <CreatorCompare kols={KOLS} onClose={() => {}} />
    </I18nProvider>
  );
}

beforeEach(() => {
  api.compareSaivareeKols.mockReset();
  api.analyzeSaivareeKol.mockReset();
});

describe('CreatorCompare', () => {
  it('loads cached comparison and never starts analysis', async () => {
    api.compareSaivareeKols.mockResolvedValue({
      creators: [
        { kol_id: 'kol-a', username: 'creator.a', analysis_status: 'available', observed_metrics: { median_views: 12000, p25_views: 8000, p75_views: 16000 } },
        { kol_id: 'kol-b', username: 'creator.b', analysis_status: 'available', observed_metrics: { median_views: 9000, p25_views: 6000, p75_views: 13000 } },
      ],
    });

    renderCompare();

    await screen.findByText('12.0K');
    expect(screen.getByText('9.0K')).toBeInTheDocument();
    expect(api.compareSaivareeKols).toHaveBeenCalledWith(['kol-a', 'kol-b']);
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });

  it('formats score metrics and ratio metrics using the correct scales', async () => {
    api.compareSaivareeKols.mockResolvedValue({
      creators: [
        {
          kol_id: 'kol-a',
          username: 'creator.a',
          analysis_status: 'available',
          observed_metrics: {
            median_views: 200,
            p25_views: 143,
            p75_views: 237,
            recent_weighted_median_views: 200,
            view_consistency: 88.05,
            viral_dependency: 0.33,
            views_per_follower: 0.0042,
          },
          evidence_quality: { confidence_score: 27 },
        },
        {
          kol_id: 'kol-b',
          username: 'creator.b',
          analysis_status: 'available',
          observed_metrics: {
            median_views: 109,
            p25_views: 80,
            p75_views: 301,
            recent_weighted_median_views: 109,
            view_consistency: 36.03,
            viral_dependency: 0.54,
            views_per_follower: 0.0,
          },
          evidence_quality: { confidence_score: 27 },
        },
      ],
    });

    renderCompare();

    await screen.findByText('88%');
    expect(screen.getByText('36%')).toBeInTheDocument();
    expect(screen.getByText('33%')).toBeInTheDocument();
    expect(screen.getByText('54%')).toBeInTheDocument();
    expect(screen.getByText('0.0042')).toBeInTheDocument();
    expect(screen.getAllByText('27%')).toHaveLength(2);
    expect(screen.queryByText('8805%')).not.toBeInTheDocument();
    expect(screen.queryByText('2700%')).not.toBeInTheDocument();
  });

  it('shows missing analysis instead of zero values', async () => {
    api.compareSaivareeKols.mockResolvedValue({
      creators: [
        { kol_id: 'kol-a', username: 'creator.a', analysis_status: 'missing' },
        { kol_id: 'kol-b', username: 'creator.b', analysis_status: 'available', observed_metrics: { median_views: 9000 } },
      ],
    });

    renderCompare();

    await screen.findByText(/no analysis yet/i);
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^0%$/)).not.toBeInTheDocument();
  });

  it('surfaces analyzer unavailable state without triggering analysis', async () => {
    const error = new Error('unavailable');
    error.statusCode = 503;
    api.compareSaivareeKols.mockRejectedValue(error);

    renderCompare();

    await screen.findByText(/analyzer unavailable/i);
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });
});
