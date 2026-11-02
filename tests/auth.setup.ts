import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

// Replace these with your actual Riot credentials
const RIOT_USERNAME = '';
const RIOT_PASSWORD = '';

async function loginToRiftbound(): Promise<void> {
    
    const browser = await chromium.launch({
        headless: false,
        args: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled' 
        ]
    });
//replace with your specs
    const context = await browser.newContext({ 
        viewport: null,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();

    try {
        console.log('Navigating directly to Riftbound Events...');
        await page.goto('https://playriftbound.com/en-US/events/');

        console.log('Clicking Sign In...');
        await page.click('text=Sign In');

        console.log('Waiting for authentication fields...');
        await page.waitForSelector("input[name='username']");

        // Focus the inputs and simulate a human typing with realistic delays
        //slow and controlled gents
        console.log('Typing username...');
        await page.focus("input[name='username']");
        await page.type("input[name='username']", RIOT_USERNAME, { delay: 120 }); 

        console.log('Typing password...');
        await page.focus("input[name='password']");
        await page.type("input[name='password']", RIOT_PASSWORD, { delay: 145 });

        console.log('Submitting credentials...');
        // Press Enter to submit naturally
        await page.press("input[name='password']", 'Enter');

        console.log('Waiting for post-login redirect back to events (or manual 2FA entry)...');
        await page.waitForURL('**/events/**', { timeout: 90000 });

        console.log('Successfully authorized and loaded events dashboard!');

await fs.promises.mkdir('playwright/.auth', { recursive: true });

await context.storageState({
  path: 'playwright/.auth/user.json'
});

console.log('Authentication state saved!');

        // Keeps the automated window open so you can play your matches
        await new Promise(() => {});



    } catch (error) {
        console.error('Execution halted:', error);
    }
}

loginToRiftbound();

