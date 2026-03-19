const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

test.describe('QR Code Platform', () => {

  // Clean database before each test via API
  test.beforeEach(async ({ page, request }) => {
    // Delete all existing QR codes
    const res = await request.get('/api/qrcodes');
    const codes = await res.json();
    for (const qr of codes) {
      await request.delete(`/api/qrcodes/${qr.id}`);
    }
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('loads the dashboard', async ({ page }) => {
    await expect(page.locator('header h1')).toHaveText('QR Code Platform');
    await expect(page.locator('.create-section h2')).toHaveText('Create New QR Code');
    await expect(page.locator('#totalCodes')).toBeVisible();
    await expect(page.locator('#totalScans')).toBeVisible();
  });

  test('create a URL-based QR code', async ({ page }) => {
    await page.fill('#urlName', 'Test Website');
    await page.fill('#urlDest', 'https://example.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });
    await expect(card.locator('.qr-info h3')).toContainText('Test Website');
    await expect(card.locator('.qr-type')).toHaveText('url');
    await expect(card.locator('.qr-dest')).toContainText('https://example.com');
    await expect(page.locator('#totalCodes')).toHaveText('1');
  });

  test('create a file-based QR code', async ({ page }) => {
    const testFilePath = path.join(__dirname, 'test-upload.txt');
    fs.writeFileSync(testFilePath, 'Hello from Playwright test');

    await page.click('.create-tab[data-tab="file"]');
    await expect(page.locator('#fileForm')).toBeVisible();

    await page.fill('#fileName', 'Test Document');
    await page.locator('#fileInput').setInputFiles(testFilePath);
    await page.click('#fileForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });
    await expect(card.locator('.qr-type')).toHaveText('file');
    await expect(card.locator('.qr-dest')).toContainText('test-upload.txt');

    fs.unlinkSync(testFilePath);
  });

  test('QR code image loads', async ({ page }) => {
    await page.fill('#urlName', 'Image Test');
    await page.fill('#urlDest', 'https://example.com/image-test');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });

    const img = card.locator('.qr-img img');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', /\/api\/qrcodes\/.*\/image/);

    const loaded = await img.evaluate(el => el.naturalWidth > 0);
    expect(loaded).toBe(true);
  });

  test('edit QR code - change URL', async ({ page }) => {
    await page.fill('#urlName', 'Edit Test');
    await page.fill('#urlDest', 'https://original-url.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });

    await card.locator('button', { hasText: 'Edit' }).click();
    const modal = page.locator('#editModal');
    await expect(modal).toHaveClass(/active/);

    await expect(page.locator('#editName')).toHaveValue('Edit Test');
    await expect(page.locator('#editUrl')).toHaveValue('https://original-url.com');

    await page.fill('#editUrl', 'https://new-destination.com');
    await page.fill('#editName', 'Edit Test Updated');
    await page.click('#editForm .btn-primary');

    await expect(card.locator('.qr-info h3')).toContainText('Edit Test Updated', { timeout: 5000 });
    await expect(card.locator('.qr-dest')).toContainText('https://new-destination.com');
  });

  test('edit QR code - switch from URL to file', async ({ page }) => {
    await page.fill('#urlName', 'Switch Test');
    await page.fill('#urlDest', 'https://will-be-replaced.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });
    await expect(card.locator('.qr-type')).toHaveText('url');

    const testFilePath = path.join(__dirname, 'switch-test.txt');
    fs.writeFileSync(testFilePath, 'Switched to file');

    await card.locator('button', { hasText: 'Edit' }).click();
    await page.click('[data-edit-tab="file"]');
    await page.locator('#editFileInput').setInputFiles(testFilePath);
    await page.click('#editForm .btn-primary');

    await expect(card.locator('.qr-type')).toHaveText('file', { timeout: 5000 });
    await expect(card.locator('.qr-dest')).toContainText('switch-test.txt');

    fs.unlinkSync(testFilePath);
  });

  test('toggle QR code active/inactive', async ({ page }) => {
    await page.fill('#urlName', 'Toggle Test');
    await page.fill('#urlDest', 'https://toggle-test.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });
    await expect(card.locator('.qr-status')).toHaveClass(/active/);

    await card.locator('button', { hasText: 'Edit' }).click();
    await page.uncheck('#editActive');
    await page.click('#editForm .btn-primary');

    await expect(card.locator('.qr-status')).toHaveClass(/inactive/, { timeout: 5000 });
  });

  test('delete QR code', async ({ page }) => {
    await page.fill('#urlName', 'Delete Me');
    await page.fill('#urlDest', 'https://delete-me.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });

    page.on('dialog', dialog => dialog.accept());

    await card.locator('button', { hasText: 'Delete' }).click();
    await expect(card).toHaveCount(0, { timeout: 5000 });
  });

  test('search/filter QR codes', async ({ page }) => {
    await page.fill('#urlName', 'Alpha Code');
    await page.fill('#urlDest', 'https://alpha.com');
    await page.click('#urlForm .btn-primary');
    await expect(page.locator('.qr-card')).toHaveCount(1, { timeout: 5000 });

    await page.fill('#urlName', 'Beta Code');
    await page.fill('#urlDest', 'https://beta.com');
    await page.click('#urlForm .btn-primary');
    await expect(page.locator('.qr-card')).toHaveCount(2, { timeout: 5000 });

    await page.fill('#search', 'Alpha');
    await expect(page.locator('.qr-card')).toHaveCount(1);
    await expect(page.locator('.qr-card').first().locator('.qr-info h3')).toContainText('Alpha Code');

    await page.fill('#search', '');
    await expect(page.locator('.qr-card')).toHaveCount(2);
  });

  test('copy link button works', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.fill('#urlName', 'Copy Test');
    await page.fill('#urlDest', 'https://copy-test.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });

    // Wait for the "created" toast to disappear
    await page.waitForTimeout(3500);

    await card.locator('button', { hasText: 'Copy Link' }).click();
    await expect(page.getByText('Link copied')).toBeVisible();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain('/r/');
  });

  test('analytics modal opens', async ({ page }) => {
    await page.fill('#urlName', 'Analytics Test');
    await page.fill('#urlDest', 'https://analytics-test.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });

    await card.locator('button', { hasText: 'Analytics' }).click();

    const modal = page.locator('#analyticsModal');
    await expect(modal).toHaveClass(/active/);
    await expect(modal.locator('h3')).toContainText('Analytics Test');
    await expect(modal).toContainText('total scans');
  });

  test('QR redirect works for URL type', async ({ page, request }) => {
    await page.fill('#urlName', 'Redirect Test');
    await page.fill('#urlDest', 'https://example.com');
    await page.click('#urlForm .btn-primary');

    await expect(page.locator('.qr-card')).toHaveCount(1, { timeout: 5000 });

    const response = await request.get('/api/qrcodes');
    const qrcodes = await response.json();
    const qr = qrcodes.find(q => q.name === 'Redirect Test');

    const redirectResponse = await request.get(`/r/${qr.short_code}`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(redirectResponse.status()).toBe(302);
    expect(redirectResponse.headers()['location']).toBe('https://example.com');
  });

  test('inactive QR code returns 404 on redirect', async ({ page, request }) => {
    await page.fill('#urlName', 'Inactive Redirect');
    await page.fill('#urlDest', 'https://inactive.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });

    await card.locator('button', { hasText: 'Edit' }).click();
    await page.uncheck('#editActive');
    await page.click('#editForm .btn-primary');

    const response = await request.get('/api/qrcodes');
    const qrcodes = await response.json();
    const qr = qrcodes.find(q => q.name === 'Inactive Redirect');

    const redirectResponse = await request.get(`/r/${qr.short_code}`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(redirectResponse.status()).toBe(404);
  });

  test('scan count increments after redirect', async ({ page, request }) => {
    await page.fill('#urlName', 'Scan Count Test');
    await page.fill('#urlDest', 'https://count-test.com');
    await page.click('#urlForm .btn-primary');

    const card = page.locator('.qr-card');
    await expect(card).toHaveCount(1, { timeout: 5000 });
    await expect(card.locator('.qr-scans strong')).toHaveText('0');

    const listRes = await request.get('/api/qrcodes');
    const qrcodes = await listRes.json();
    const qr = qrcodes.find(q => q.name === 'Scan Count Test');

    await request.get(`/r/${qr.short_code}`, { maxRedirects: 0, failOnStatusCode: false });

    await page.reload();
    await expect(page.locator('.qr-card').locator('.qr-scans strong')).toHaveText('1', { timeout: 5000 });
  });
});
