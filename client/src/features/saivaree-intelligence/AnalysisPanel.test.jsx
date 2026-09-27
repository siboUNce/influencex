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

  it('treats 429 from Analyze as already queued instead of an error', async () => {
    const user = userEvent.setup();
    api.getSaivareeAnalysis.mockResolvedValue({ analysis_status: 'missing' });
    const error = new Error('too many requests');
    error.statusCode = 429;
    api.analyzeSaivareeKol.mockRejectedValue(error);

    renderPanel();

    const analyzeButton = await screen.findByRole('button', { name: /^analyze$/i });
    await user.click(analyzeButton);

    expect(await screen.findByText(/analysis queued/i)).toBeInTheDocument();
    expect(screen.queryByText(/unable to start analysis/i)).not.toBeInTheDocument();
    expect(analyzeButton).toBeDisabled();
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
        view_consistency: 74,
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

  it('formats score percentages and ratio percentages using their native scales', async () => {
    api.getSaivareeAnalysis.mockResolvedValue({
      analysis_status: 'available',
      observed_metrics: {
        median_views: 82,
        recent_weighted_median_views: 31,
        p25_views: 79,
        p75_views: 256,
        view_consistency: 30.88,
        viral_dependency: 0.58,
        views_per_follower: 0.0045303,
        sample_size: 5,
      },
      evidence_quality: {
        confidence_score: 27,
        sample_window_days: 90,
        confidence_grade: 'low',
        readiness: 'insufficient',
      },
      clinic_meta: {},
    });

    renderPanel();

    await screen.findByText('31%');
    expect(screen.getByText('58%')).toBeInTheDocument();
    expect(screen.getByText('27%')).toBeInTheDocument();
    expect(screen.getByText('0.0045')).toBeInTheDocument();
    expect(screen.getByText(/sample window: 90 days/i)).toBeInTheDocument();
    expect(screen.getByText(/confidence: low/i)).toBeInTheDocument();
    expect(screen.queryByText('3088%')).not.toBeInTheDocument();
    expect(screen.queryByText('2700%')).not.toBeInTheDocument();
  });

  it.each([
    [
      'decision_grade',
      'Decision grade',
      'Enough recent evidence to support a creator-selection decision.',
    ],
    [
      'directional',
      'Directional only',
      'Useful for screening, but collect more evidence before a creator-selection decision.',
    ],
    [
      'insufficient',
      'Insufficient evidence',
      'Do not use this analysis alone for a creator-selection decision.',
    ],
    [
      null,
      'Readiness unavailable',
      'Re-analyze to apply the current sampling standard.',
    ],
    [
      undefined,
      'Readiness unavailable',
      'Re-analyze to apply the current sampling standard.',
    ],
  ])('renders the %s readiness callout', async (readiness, heading, guidance) => {
    api.getSaivareeAnalysis.mockResolvedValue({
      analysis_status: 'available',
      observed_metrics: { sample_size: 30 },
      evidence_quality: readiness === undefined
        ? { sample_size: 30 }
        : { readiness, sample_size: 30 },
      clinic_meta: {},
    });

    renderPanel();

    expect(await screen.findByText(heading)).toBeInTheDocument();
    expect(screen.getByText(guidance)).toBeInTheDocument();
  });

  it.each([
    [0, 30, '30'],
    [9, 30, '30'],
    [10, 30, '30'],
    [19, 30, '30'],
    [20, 30, '30'],
    [30, 9, '9'],
    [undefined, 19, '19'],
  ])(
    'shows sample progress for evidence sample size %s and metrics sample size %s',
    async (evidenceSampleSize, metricsSampleSize, expectedSampleSize) => {
      api.getSaivareeAnalysis.mockResolvedValue({
        analysis_status: 'available',
        observed_metrics: { sample_size: metricsSampleSize },
        evidence_quality: evidenceSampleSize === undefined
          ? {}
          : { sample_size: evidenceSampleSize },
        clinic_meta: {},
      });

      renderPanel();

      expect(await screen.findByText(`Sample ${expectedSampleSize}/20 target`)).toBeInTheDocument();
    }
  );

  it('omits sample progress when neither evidence nor metrics includes a sample size', async () => {
    api.getSaivareeAnalysis.mockResolvedValue({
      analysis_status: 'available',
      observed_metrics: {},
      evidence_quality: {},
      clinic_meta: {},
    });

    renderPanel();

    await screen.findByText(/creator intelligence/i);
    expect(screen.queryByText(/sample .*\/20 target/i)).not.toBeInTheDocument();
  });

  it('does not call Analyzer when the creator platform is unknown', async () => {
    render(
      <I18nProvider>
        <AnalysisPanel kol={{ ...KOL, platform: 'unknown' }} />
      </I18nProvider>
    );

    await screen.findByText(/select tiktok as the platform/i);
    expect(api.getSaivareeAnalysis).not.toHaveBeenCalled();
    expect(api.analyzeSaivareeKol).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^analyze$/i })).toBeDisabled();
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
