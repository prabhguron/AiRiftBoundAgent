import { test, expect } from '@playwright/test';

test.use({
  storageState: 'playwright/.auth/user.json'
});

test('Inspect Riftbound event registration', async ({ page }) => {
  test.setTimeout(120000);

  // 1. Open Riftbound events
  await page.goto('https://playriftbound.com/en-US/events/', {
    waitUntil: 'domcontentloaded'
  });

  console.log('Opened events page:', page.url());

  // 2. Find the first event link
  const event = page.locator(
    'a[href^="/en-US/events/"]:not([href="/en-US/events/"])'
  ).first();

  await expect(event).toBeVisible({ timeout: 30000 });

  // 3. Extract its URL
  const href = await event.getAttribute('href');

  if (!href) {
    throw new Error('Event URL not found');
  }

  const eventURL = new URL(
    href,
    'https://playriftbound.com'
  ).href;

  console.log('Event URL:', eventURL);

  // 4. Navigate directly to the event page
  await page.goto(eventURL, {
    waitUntil: 'domcontentloaded'
  });

  console.log('Current URL:', page.url());

  // 5. Locate and click the first Register button or link
  const register = page
    .getByRole('button', { name: /register/i })
    .or(page.getByRole('link', { name: /register/i }))
    .first();

  await expect(register).toBeVisible({ timeout: 30000 });

  console.log('Register button found!');
  console.log('Register text:', await register.innerText());

  // Click the first register button
  await register.click();
  console.log('Clicked first Register button');

  // 6. Locate and click the second Register button (inside the pop-up modal/dialog)
  // We use a locator scoped to potential dialogs or find the next visible register action
  const confirmRegister = page
    .locator('role=dialog')
    .getByRole('button', { name: /register|confirm/i })
    .or(page.getByRole('button', { name: /register/i }).nth(1));

  // Wait for the popup/second button to be visible
  await expect(confirmRegister.first()).toBeVisible({ timeout: 10000 });

  await confirmRegister.first().click();
  console.log('Clicked second Register confirmation');

  // Optional small pause or wait for network idle to let state settle
  await page.waitForLoadState('networkidle').catch(() => {});

  // 7. Save a screenshot of the result
  await page.screenshot({
    path: 'registration-result.png',
    fullPage: true
  });

  console.log('Final URL:', page.url());

  // Keep the browser open briefly or pause if you still want to inspect manually
  await page.pause();
});