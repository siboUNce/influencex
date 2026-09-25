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
