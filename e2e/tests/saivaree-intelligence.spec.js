const { test, expect } = require('@playwright/test');

const { ANALYZER_URL, STORAGE_STATE } = require('../env');
const {
  cleanupSaivareeIntelligenceKols,
  seedSaivareeIntelligenceKols,
} = require('../helpers/db');

test.use({ storageState: STORAGE_STATE });

let fixture;

test.beforeEach(async ({ page, request }) => {
  fixture = seedSaivareeIntelligenceKols();
  await request.post(ANALYZER_URL + '/__reset');
  await page.addInitScript(() => {
    localStorage.setItem('influencex_onboarding_done_v1', '1');
    localStorage.setItem('influencex_lang', 'en');
  });
});

test.afterEach(() => {
  cleanupSaivareeIntelligenceKols(fixture);
  fixture = null;
});

test('opening a cached creator reads analysis without starting a paid run', async ({ page, request }) => {
  await page.goto('/#/kol-database');
  await expect(page.getByRole('heading', { name: 'KOL Database' })).toBeVisible();

  await page.getByRole('button', { name: 'Open details for E2E Cached Creator' }).click();

  await expect(page.getByText('Saivaree Creator Intelligence')).toBeVisible();
  await expect(page.getByText('12.3K')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();

  const state = await (await request.get(ANALYZER_URL + '/__state')).json();
  expect(state.analyze_calls).toBe(0);
  expect(state.analysis_reads).toBeGreaterThan(0);
});

test('explicit Analyze queues once and refreshes to cached result', async ({ page, request }) => {
  await page.goto('/#/kol-database');
  await page.getByRole('button', { name: 'Open details for E2E Fresh Creator' }).click();

  await expect(page.getByText('No analysis yet')).toBeVisible();
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByText('Analysis queued')).toBeVisible();

  let state = await (await request.get(ANALYZER_URL + '/__state')).json();
  expect(state.analyze_calls).toBe(1);

  await page.getByRole('button', { name: 'Refresh analysis' }).click();
  await expect(page.getByText('5.0K')).toBeVisible();

  state = await (await request.get(ANALYZER_URL + '/__state')).json();
  expect(state.analyze_calls).toBe(1);
});
