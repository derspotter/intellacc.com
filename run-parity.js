const { chromium } = require('playwright');

const SOLID_URL = 'http://127.0.0.1:4174';

async function checkConsole() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto(`${SOLID_URL}/#login?skin=terminal`);
  await page.waitForTimeout(2000);
  
  // Terminal skin uses the TerminalApp which has its own LoginModal 
  // Let's click "CONTINUE" first since it's a multi-stage login
  try {
    await page.fill('input[type="email"]', 'test@test.com');
    await page.click('button[type="submit"]'); // Continue
    await page.waitForTimeout(500);
  } catch (e) {
    console.log("Couldn't advance terminal login:", e.message);
  }
  
  const html = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(el => ({id: el.id, type: el.type}));
  });
  
  console.log('Inputs found after advancing:', html);
  
  await browser.close();
}

checkConsole();
