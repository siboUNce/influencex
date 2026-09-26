import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toast = { success: vi.fn(), error: vi.fn() };

vi.mock('../api/client', () => ({
  api: {
    getSaivareeSettings: vi.fn(),
    updateSaivareeSettings: vi.fn(),
    testSaivareeSettings: vi.fn(),
  },
}));

vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}));

import { api } from '../api/client';
import CreatorIntelligenceSettingsPage from './CreatorIntelligenceSettingsPage';

const SETTINGS = {
  discovery_provider_mode: 'apify',
  apify_live_provider_enabled: true,
  apify_token_configured: true,
  apify_token_masked: '••••6789',
  apify_max_cost_per_run_usd: '0.50',
  apify_max_daily_cost_usd: '5.00',
  apify_budget_timezone: 'Asia/Bangkok',
  apify_run_deadline_seconds: 300,
  apify_poll_interval_seconds: 2,
  apify_discovery_keyword_actor_id: 'keyword',
  apify_discovery_hashtag_actor_id: 'hashtag',
  apify_discovery_discover_actor_id: 'discover',
  apify_discovery_expansion_actor_id: 'expand',
  apify_creator_enrichment_actor_id: 'enrich',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getSaivareeSettings.mockResolvedValue(SETTINGS);
  api.updateSaivareeSettings.mockResolvedValue(SETTINGS);
  api.testSaivareeSettings.mockResolvedValue({ status: 'ok', provider: 'apify', apify_http: 200 });
});

describe('CreatorIntelligenceSettingsPage', () => {
  it('shows a masked token and never puts the saved token into the input', async () => {
    render(<CreatorIntelligenceSettingsPage />);

    await screen.findByText(/saved token: ••••6789/i);
    const tokenInput = screen.getByPlaceholderText(/leave blank to keep current token/i);

    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(tokenInput).toHaveValue('');
    expect(screen.queryByDisplayValue(/6789/)).not.toBeInTheDocument();
  });

  it('keeps the existing token when saving a blank token and can test connection', async () => {
    const user = userEvent.setup();
    render(<CreatorIntelligenceSettingsPage />);

    await user.click(await screen.findByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(api.updateSaivareeSettings).toHaveBeenCalledTimes(1));
    const payload = api.updateSaivareeSettings.mock.calls[0][0];
    expect(payload).not.toHaveProperty('apify_token');

    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await screen.findByText(/apify connection ok/i);
    expect(api.testSaivareeSettings).toHaveBeenCalledTimes(1);
  });
});
