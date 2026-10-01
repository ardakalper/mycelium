import { test, expect } from '@playwright/test';

const URL = '/?nosw=1&seed=4242';
const game = (page, fn, arg) => page.evaluate(fn, arg);
async function start(page, q = '') {
  await page.goto(URL + q);
  await expect(page.locator('#dlg-intro')).toBeVisible();
  await page.click('#intro-go');
  await expect(page.locator('body')).toHaveClass(/ready/);
}

test('first visit: the intro, the world, and growth', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page, '&speed=10');
  await expect(page.locator('#biome-name')).toHaveText('Beech Wood');
  await expect(page.locator('#r-nut')).toHaveText(/^\d/);
  const n0 = await game(page, () => window.__myc.world.nodeCount);
  await expect.poll(() => game(page, () => window.__myc.world.nodeCount)).toBeGreaterThan(n0 + 20);
  // the canvas shows the night sky, soil and a lit network
  // the canvas is painted: the colony's origin glows, the sky above is dark blue
  const px = await page.evaluate(() => {
    const m = window.__myc, c = document.querySelector('#world'), g = c.getContext('2d'), dpr = devicePixelRatio;
    const o = m.renderer.toScreen(m.world.origin.x, m.world.origin.y), sky = m.renderer.toScreen(m.world.origin.x, -40);
    return { origin: Array.from(g.getImageData(o.x * dpr, o.y * dpr, 1, 1).data), sky: Array.from(g.getImageData(sky.x * dpr, sky.y * dpr, 1, 1).data) };
  });
  expect(px.origin[1]).toBeGreaterThan(180);
  expect(px.sky[2]).toBeGreaterThan(px.sky[0]);
  await expect(page.locator('[data-tab="strains"]')).toBeHidden();
  expect(errors).toEqual([]);
});

test('buying upgrades changes the colony', async ({ page }) => {
  await start(page);
  await game(page, () => { window.__myc.state.nutrients = window.__myc.Big.of(1e5); window.__myc.refresh(); });
  const card = page.locator('.card[data-id="growth"]');
  await expect(card).toBeEnabled();
  await card.click();
  await expect(card.locator('.lvl')).toHaveText('1');
  await page.click('[data-amount="max"]');
  await page.locator('.card[data-id="branching"]').click();
  const lv = await game(page, () => window.__myc.state.levels.branching);
  expect(lv).toBeGreaterThan(3);
  await expect(page.locator('.card[data-id="branching"] .lvl')).toHaveText(String(lv));
  // sugar upgrades appear once a tree trades
  await game(page, () => { window.__myc.state.sugar = window.__myc.Big.of(1e4); window.__myc.refresh(); });
  await expect(page.locator('.card[data-id="symbiosis"]')).toBeVisible();
});

test('lures steer the hyphae, and earthworms pay', async ({ page }) => {
  await start(page);
  const box = await page.locator('#world').boundingBox();
  const at = await game(page, () => window.__myc.renderer.toScreen(60, 40));
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await expect.poll(() => game(page, () => !!window.__myc.renderer.lure)).toBe(true);
  await expect(page.locator('#hint')).toContainText('lure ready in');
  // a worm crossing right here
  await game(page, () => { window.__myc.renderer.worm = { x: 100, y: 30, dir: 0, t: 0 }; });
  const before = await game(page, () => window.__myc.state.nutrients.toNumber());
  const wp = await game(page, () => window.__myc.renderer.toScreen(100, 30));
  await page.mouse.click(box.x + wp.x, box.y + wp.y);
  await expect(page.locator('#toasts')).toContainText('An earthworm turns the soil');
  expect(await game(page, () => window.__myc.state.nutrients.toNumber())).toBeGreaterThan(before);
  expect(await game(page, () => window.__myc.state.worms)).toBe(1);
});

test('saves survive a reload, and time away is paid out', async ({ page }) => {
  await start(page);
  await game(page, () => window.__myc.tick(600));
  const snap = await game(page, () => ({ nodes: window.__myc.world.nodeCount, nut: window.__myc.state.nutrients.toJSON() }));
  await game(page, () => window.__myc.save());
  // pretend we left two hours ago
  await page.evaluate(() => {
    const o = JSON.parse(localStorage.getItem('mycelium:save'));
    o.state.lastSeen = Date.now() - 2 * 3600 * 1000; o.rateN = '5e1';
    localStorage.setItem('mycelium:save', JSON.stringify(o));
  });
  await page.reload();
  await expect(page.locator('#dlg-away')).toBeVisible();
  await expect(page.locator('#away-time')).toHaveText('2 h 0 min');
  await expect(page.locator('#away-body')).toContainText('nutrients', { timeout: 20_000 });
  const after = await game(page, () => ({ nodes: window.__myc.world.nodeCount, nut: window.__myc.state.nutrients.toNumber() }));
  expect(after.nodes).toBeGreaterThanOrEqual(snap.nodes);
  expect(after.nut).toBeGreaterThan(Number(snap.nut) + 50 * 0.4 * 6000); // most of two hours at 40%
  await page.click('#dlg-away [data-close]');
  await expect(page.locator('#dlg-intro')).toBeHidden();
});

test('fruiting: mushrooms, spores, a new forest and strains', async ({ page }) => {
  await start(page, '&speed=4');
  await expect(page.locator('#btn-fruit')).toBeDisabled();
  await game(page, () => { const m = window.__myc; m.state.runNutrients = m.E.FRUIT_AT.mul(30); m.refresh(); });
  await expect(page.locator('#btn-fruit')).toHaveClass(/ready/);
  await expect(page.locator('#fruit-info')).toHaveText('release 7 spores');
  await page.click('#btn-fruit');
  await expect(page.locator('#dlg-fruit')).toContainText('Pine Barrens');
  await page.click('#fruit-yes');
  await expect(page.locator('#biome-name')).toHaveText('Pine Barrens', { timeout: 15_000 });
  await expect(page.locator('#forest-n')).toHaveText('Forest 2');
  await expect(page.locator('#r-spo')).toHaveText('7');
  await expect(page.locator('[data-tab="strains"]')).toBeVisible();
  await expect(page.locator('#tab-strains')).toBeVisible();
  await page.locator('.card[data-strain="appetite"]').click();
  await expect(page.locator('#r-spo')).toHaveText('5');
  await expect(page.locator('.card[data-strain="appetite"] .lvl')).toHaveText('1');
  expect(await game(page, () => window.__myc.state.levels.growth)).toBe(0);
});

test('settings: copy and load a save, sound, start over', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await start(page);
  await game(page, () => { window.__myc.state.levels.enzymes = 6; window.__myc.state.forest = 2; });
  await page.click('[data-tab="colony"]');
  await page.click('#set-export');
  // the save is compressed asynchronously; wait for it to land
  await expect(page.locator('#set-export')).toHaveAttribute('data-save', /^.{100,}$/s);
  const text = await page.locator('#set-export').getAttribute('data-save');
  await page.click('#set-sound');
  await expect(page.locator('#set-sound')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mycelium:settings')).sound)).toBe(false);
  page.once('dialog', (d) => d.accept());
  await page.click('#set-reset');
  await expect.poll(() => game(page, () => window.__myc.state.levels.enzymes)).toBe(0);
  await page.click('#set-import');
  await page.fill('#import-text', text);
  await page.click('#import-go');
  await expect(page.locator('#toasts')).toContainText('Save loaded.');
  expect(await game(page, () => window.__myc.state.levels.enzymes)).toBe(6);
  await expect(page.locator('#biome-name')).toHaveText('Cloud Forest');
  await page.click('#set-import');
  await page.fill('#import-text', 'not a save');
  await page.click('#import-go');
  await expect(page.locator('#import-msg')).toHaveText('That save could not be read.');
});

test('phone: the world on top, the panel below, no sideways scroll', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await start(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const world = await page.locator('#world').boundingBox(), panel = await page.locator('.panel').boundingBox();
  expect(panel.y).toBeGreaterThanOrEqual(world.y + world.height - 1);
  await ctx.close();
});
