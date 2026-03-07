const { chromium } = require('playwright');

const VAN_URL = 'http://127.0.0.1:5173';
const SOLID_URL = 'http://127.0.0.1:4174';

async function checkHeights() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto(`${VAN_URL}/#home`);
  await page.waitForTimeout(3000);
  
  let vanLimit = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.post-card, .post-item')).length;
  });
  
  await page.goto(`${SOLID_URL}/#home?skin=van`);
  await page.waitForTimeout(3000);
  
  let solidLimit = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.post-card, .post-item')).length;
  });
  
  console.log(`VanJS Posts Loaded: ${vanLimit}`);
  console.log(`SolidJS Posts Loaded: ${solidLimit}`);
  await browser.close();
}

checkHeights();
