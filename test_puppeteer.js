const puppeteer = require('puppeteer-core');
const fs = require('fs');

async function test() {
  console.log("Starting Puppeteer test without custom args...");
  const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  
  try {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
    
    console.log("Browser launched successfully!");
    
    browser.on('disconnected', () => console.log('BROWSER EVENT: Browser disconnected!'));
    
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
    page.on('error', err => console.error('PAGE CRASHED:', err.message));
    page.on('close', () => console.log('PAGE EVENT: Page closed!'));

    console.log("Navigating to https://web.whatsapp.com/ ...");
    await page.goto('https://web.whatsapp.com/', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log("Navigation complete. Waiting 15 seconds...");
    
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    console.log("Checking if browser/page is still open...");
    console.log("Browser connected state:", browser.connected);
    console.log("Page isClosed state:", page.isClosed());

    console.log("Taking screenshot...");
    await page.screenshot({ path: 'scratch_screenshot.png' });
    console.log("Screenshot saved as scratch_screenshot.png!");
    
    await browser.close();
    console.log("Test finished successfully!");
  } catch (err) {
    console.error("Test failed with error:", err);
  }
}

test();
