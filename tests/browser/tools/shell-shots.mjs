// Screenshots of the shell (spec §4) at the six review widths for admin and
// bartender, plus the palette, notifications, account menu and More sheet.
// Not run by `npm run test:browser`.
//   node tests/browser/tools/shell-shots.mjs --out DIR
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchAtlas, USERS } from '../harness.mjs';
import { emptyFunctions } from '../fixtures.mjs';

const outIndex = process.argv.indexOf('--out');
const OUT = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : 'shell-shots');
mkdirSync(OUT, { recursive: true });

const WIDTHS = [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [430, 932], [390, 844]];
const fixtures = {
  tables: {
    inventory_items: [
      { id: 'campari', name: 'Campari', category: 'Liqueurs', unit: 'bottles', par_level: 4, supplier: 'Globus', active: true, cost_price: 3900 },
      { id: 'gin', name: 'Gin', category: 'Gin', unit: 'bottles', par_level: 2, supplier: 'Globus', active: true, cost_price: 5000 }
    ],
    recipes: [{ id: 'spritz', name: 'Campari Spritz', active: true, yield_quantity: 1, recipe_ingredients: [] }],
    suppliers: [{ id: 's1', name: 'Globus', email: 'orders@globus.example' }]
  },
  functions: { ...emptyFunctions() }
};

const only = process.argv.includes('--quick');
for (const [who, user] of [['admin', USERS.admin], ['bartender', USERS.bartender]]) {
  for (const [width, height] of WIDTHS) {
    if (only && width !== 1440 && width !== 390) continue;
    const { page, close, record } = await launchAtlas({ user, fixtures, viewport: { width, height } });
    try {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${who}-${width}-home.png`) });
      await page.evaluate(() => window.AtlasShell.navigate('#inventory'));
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${who}-${width}-inventory.png`) });
      if (width >= 768) {
        await page.click('#atlas-omni');
        await page.keyboard.type('camp');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${who}-${width}-palette.png`) });
        await page.keyboard.press('Escape');
        await page.click('#atlas-notifications-btn');
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(OUT, `${who}-${width}-notifications.png`) });
        await page.keyboard.press('Escape');
        await page.click('#atlas-account-btn');
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(OUT, `${who}-${width}-account.png`) });
        await page.keyboard.press('Escape');
      } else {
        await page.click('#atlas-more-btn');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${who}-${width}-more.png`) });
        await page.keyboard.press('Escape');
        await page.click('#atlas-phone-search');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${who}-${width}-palette.png`) });
        await page.keyboard.press('Escape');
        await page.click('#atlas-notifications-btn');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${who}-${width}-notifications.png`) });
      }
      if (width === 1024) {
        await page.click('#atlas-sidebar-toggle');
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(OUT, `${who}-${width}-overlay-sidebar.png`) });
      }
      if (record.pageErrors.length) console.log(who, width, 'page errors', record.pageErrors);
    } finally { await close(); }
  }
}
{
  const { page, close } = await launchAtlas({ signedIn: false, waitReady: false, viewport: { width: 1440, height: 900 } });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'signin-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'signin-390.png') });
  for (const file of ['invitation.html', 'recovery.html']) {
    await page.goto(`http://localhost:4173/${file}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `${file.replace('.html', '')}-390.png`) });
  }
  await close();
}
console.log('shots in', OUT);
