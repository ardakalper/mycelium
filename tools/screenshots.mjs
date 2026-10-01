// README screenshots: a grown colony mid-forest, and the moment it fruits.
// Usage: npm run build, node tools/serve.mjs 4182 in another shell, then PW_CHROMIUM_PATH=... node tools/screenshots.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const exe = process.env.PW_CHROMIUM_PATH, OUT = process.env.OUT || 'docs/img';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:4182/?nosw=1&seed=777');
await page.click('#intro-go');
// play about fifteen minutes in fast-forward, buying the way a player might
for (let k = 0; k < 90; k++) {
  await page.evaluate(() => {
    const m = window.__myc;
    m.tick(200);
    for (const id of ['growth', 'branching', 'enzymes', 'chemotropism', 'rhizomorphs', 'anastomosis', 'symbiosis', 'saprotrophy', 'exoenzymes']) m.E.buy(m.state, id, 1);
    m.world.setParams(m.E.params(m.state));
  });
}
await page.evaluate(() => { const m = window.__myc; m.renderer.lure = { x: 250, y: 70, t0: performance.now(), until: performance.now() + 15000 }; m.world.setLure({ x: 250, y: 70 }); });
await page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; window.__myc.tick(100); });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/colony.png` });
// fruit
await page.evaluate(() => { const m = window.__myc; m.state.runNutrients = m.E.FRUIT_AT.mul(4); m.refresh(); });
await page.click('#btn-fruit');
await page.click('#fruit-yes');
await page.waitForTimeout(3300);
await page.screenshot({ path: `${OUT}/fruiting.png` });
await browser.close();
console.log('screenshots written');
