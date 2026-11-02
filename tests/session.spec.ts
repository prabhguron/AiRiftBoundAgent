
import { test } from '@playwright/test';

test.use({
  storageState: 'playwright/.auth/user.json',
});

test('Reuse Riftbound session', async ({ page }) => {
  await page.goto('https://playriftbound.com/en-US/events/');

  console.log('Current URL:', page.url());

  // Inspect whether you are logged in
  await page.pause();
});
