import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/client', () => ({
  api: {
    getSaivareeAnalysis: vi.fn(),
    analyzeSaivareeKol: vi.fn(),
  },
  setApiTranslator: vi.fn(),
}));

import { api } from '../../api/client';
import { I18nProvider } from '../../i18n';
import AnalysisPanel from './AnalysisPanel';

const KOL = {
  id: 'kol-1',
  platform: 'tiktok',
  username: 'creator.name',
};

function renderPanel() {
  return render(
    <I18nProvider>
      <AnalysisPanel kol={KOL} />
    </I18nProvider>
  );
}

beforeEach(() => {
  api.getSaivareeAnalysis.mockReset();
  api.analyzeSaivareeKol.mockReset();
});

describe('AnalysisPanel', () => {
  it('loads cached analysis but does not start analysis on mount', async () => {
    api.getSaivareeAnalysis.mockResolvedValue({ analysis_status: 'missing' });

    renderPanel();

    await screen.findByText(/no analysis yet/i);
    expect(api.getSaivareeAnalysis).toHaveBeenCalledWith('kol-1');
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
  });

  it('starts analysis only after the user clicks Analyze', async () => {
    const user = userEvent.setup();
    api.getSaivareeAnalysis
      .mockResolvedValueOnce({ analysis_status: 'missing' })
      .mockResolvedValueOnce({ analysis_status: 'missing' });
    api.analyzeSaivareeKol.mockResolvedValue({
      status: 'queued',
      creator_id: 'creator-1',
    });

    renderPanel();

    await user.click(await screen.findByRole('button', { name: /^analyze$/i }));

    expect(api.analyzeSaivareeKol).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/analysis queued/i)).toBeInTheDocument();
  });

  it('renders persisted metrics without coercing missing values to zero', async () => {
    api.getSaivareeAnalysis.mockResolvedValue({
      analysis_status: 'available',
      analyzed_at: '2026-09-25T06:30:00Z',
      observed_metrics: {
        median_views: 12345,
        recent_weighted_median_views: 11000,
        p25_views: 8000,
        p75_views: 16000,
        view_consistency: 0.74,
        viral_dependency: 0.18,
        views_per_follower: null,
      },
      evidence_quality: {},
      clinic_meta: {},
    });

    renderPanel();

    await screen.findByText('12.3K');
    expect(screen.getByText('8.0K – 16.0K')).toBeInTheDocument();
    expect(screen.getByText('74%')).toBeInTheDocument();
    expect(screen.getByText('18%')).toBeInTheDocument();
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /re-analyze/i })).toBeInTheDocument();
  });

  it('shows unavailable state and never fabricates zero metrics', async () => {
    const error = new Error('unavailable');
    error.statusCode = 503;
    api.getSaivareeAnalysis.mockRejectedValue(error);

    renderPanel();

    await screen.findByText(/analyzer unavailable/i);
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^0%$/)).not.toBeInTheDocument();
  });

  it('refreshes cached analysis after an explicit queued run without auto-retrying analyze', async () => {
    const user = userEvent.setup();
    api.getSaivareeAnalysis
      .mockResolvedValueOnce({ analysis_status: 'missing' })
      .mockResolvedValueOnce({
        analysis_status: 'available',
        observed_metrics: { median_views: 5000 },
        evidence_quality: {},
        clinic_meta: {},
      });
    api.analyzeSaivareeKol.mockResolvedValue({ status: 'queued' });

    renderPanel();

    await user.click(await screen.findByRole('button', { name: /^analyze$/i }));
    await user.click(screen.getByRole('button', { name: /refresh analysis/i }));

    await waitFor(() => expect(api.getSaivareeAnalysis).toHaveBeenCalledTimes(2));
    expect(api.analyzeSaivareeKol).toHaveBeenCalledTimes(1);
    await screen.findByText('5.0K');
  });
});
