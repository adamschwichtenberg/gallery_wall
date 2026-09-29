import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const OUT = process.env.OUT || '/tmp/claude-0/-home-user-gallery-wall/5782ae7e-d42e-5a5b-a340-69d5d645b190/scratchpad';
const URL_ = process.argv[2] || 'http://localhost:5173/';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const shot = (n) => p.screenshot({ path: `${OUT}/e2e-${n}.png` });
const step = async (name, fn) => { const t = Date.now(); await fn(); console.log(`✓ ${name} (${Date.now() - t}ms)`); };

async function dragImagePoint(testid, x, y) {
  // Move a pin to image coordinates (x, y).
  const img = await p.locator('.stage-img').boundingBox();
  const natural = await p.locator('.stage-img').evaluate((el) => parseFloat(el.style.width));
  const k = img.width / natural;
  const pin = await p.getByTestId(testid).boundingBox();
  const sx = pin.x + pin.width / 2, sy = pin.y + pin.height / 2;
  await p.mouse.move(sx, sy);
  await p.mouse.down();
  await p.mouse.move((sx + img.x + x * k) / 2, (sy + img.y + y * k) / 2, { steps: 4 });
  await p.mouse.move(img.x + x * k, img.y + y * k, { steps: 4 });
  await p.mouse.up();
}
async function dragStagePoint(stageIndex, testid, x, y) {
  const stage = p.locator('.stage-img').nth(stageIndex);
  const img = await stage.boundingBox();
  const natural = await stage.evaluate((el) => parseFloat(el.style.width));
  const k = img.width / natural;
  const pin = await p.getByTestId(testid).boundingBox();
  const sx = pin.x + pin.width / 2, sy = pin.y + pin.height / 2;
  await p.mouse.move(sx, sy);
  await p.mouse.down();
  await p.mouse.move(img.x + x * k, img.y + y * k, { steps: 8 });
  await p.mouse.up();
}
async function typeLen(label, v) {
  const input = p.locator('label.field', { hasText: label }).locator('input').first();
  await input.fill(v);
}

await p.goto(URL_);
await step('home', async () => { await p.waitForSelector('text=Plan your first gallery wall'); await shot('01-home'); });

for (const [file, w, h, rotate] of [['4.jpg', '13', '15', 0], ['5.jpg', '12', '14', 1]]) {
  await step(`frame ${file}`, async () => {
    await p.getByTestId('tab-frames').click();
    await p.getByTestId('add-frame').click();
    await p.getByTestId('library-input').setInputFiles(`dev/samples/${file}`);
    await p.waitForSelector('text=Corners & size', { timeout: 30000 });
    await p.waitForTimeout(300);
    if (rotate) await p.locator('button', { hasText: '90°' }).nth(1).click();
    await typeLen('Outside width', rotate ? h : w);
    await typeLen('Outside height', rotate ? w : h);
    await shot(`02-corners-${file}`);
    await p.getByTestId('next').click();
    await p.waitForSelector('text=This is the cut-out', { timeout: 30000 });
    await p.waitForTimeout(300);
    await shot(`03-outline-${file}`);
    await p.getByTestId('next').click();
    await p.waitForSelector('text=Openings are the windows', { timeout: 30000 });
    await p.waitForTimeout(300);
    await shot(`04-openings-${file}`);
    await p.getByTestId('next').click();
    await p.waitForSelector('text=How many do you own', { timeout: 30000 });
    await p.waitForTimeout(300);
    await shot(`05-details-${file}`);
    await p.getByTestId('save').click();
    await p.waitForSelector('.fullscreen-editor', { state: 'detached' });
  });
}
await p.waitForTimeout(500);
await shot('06-frames');

await step('picture', async () => {
  await p.getByTestId('tab-pictures').click();
  await p.getByTestId('add-picture').click();
  await p.getByTestId('library-input').setInputFiles('dev/samples/3.jpg');
  await p.waitForSelector('text=Crop & straighten');
  await p.getByTestId('next').click();
  await p.waitForSelector('text=Main color');
  await p.waitForTimeout(500);
  await shot('06b-picture-color');
  await p.getByTestId('save').click();
  await p.waitForSelector('.fullscreen-editor', { state: 'detached' });
});

await step('wall', async () => {
  await p.locator('.topnav button').first().click();
  await p.getByTestId('new-wall').click();
  await p.locator('.modal input').fill('Hallway');
  await p.getByTestId('create-wall').click();
  await p.getByTestId('library-input').setInputFiles('dev/samples/3.jpg');
  await p.waitForSelector('text=Pin a rectangle you know');
  await p.waitForTimeout(400);
  const quad = [[90, 560], [900, 240], [900, 1960], [105, 1440]];
  for (let i = 0; i < 4; i++) await dragImagePoint(`pin-${i}`, quad[i][0], quad[i][1]);
  await typeLen('Width', '64');
  await typeLen('Height', '96');
  await shot('07-wall-pins');
  await p.getByTestId('next').click();
  await p.waitForSelector('text=How do you want to work?');
  await p.waitForTimeout(400);
  await shot('08-wall-review');
  await p.getByTestId('save').click();
  await p.waitForSelector('.fullscreen-editor', { state: 'detached' });
  await p.waitForTimeout(600);
  await shot('09-arrange-empty');
});

await step('place frames', async () => {
  const cards = p.getByTestId('tray-frame');
  await cards.nth(0).click();
  await cards.nth(1).click();
  await p.waitForTimeout(300);
  await shot('10-placed');
  // drag the selected item
  const it = p.getByTestId('placed-item').nth(1);
  const bb = await it.boundingBox();
  await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await p.mouse.down();
  await p.mouse.move(bb.x + bb.width / 2 + 80, bb.y + bb.height / 2 + 10, { steps: 8 });
  await shot('11-dragging');
  await p.mouse.up();
});

await step('undo/redo', async () => {
  await p.getByTestId('undo').click();
  await p.getByTestId('redo').click();
});

await step('autofill', async () => {
  await p.getByTestId('tool-autofill').click();
  await p.locator('.segmented button', { hasText: 'Start fresh' }).click();
  await p.getByTestId('autofill-run').click();
  await p.waitForTimeout(300);
  await shot('12-autofill');
  await p.getByTestId('autofill-apply').click();
  await p.waitForTimeout(300);
});

await step('swap picture', async () => {
  await p.getByTestId('placed-item').first().click();
  await p.waitForSelector('[data-testid=inspector]');
  await p.locator('.list-btn', { hasText: 'Original picture' }).first().click();
  await p.locator('text=Suggested pictures').waitFor();
  await p.locator('[data-testid=inspector] .tray-grid button').first().click();
  await p.waitForTimeout(500);
  await shot('13-swapped');
});

await step('paint', async () => {
  await p.getByTestId('tool-paint').click();
  await p.waitForSelector('.mask-overlay', { timeout: 30000 });
  await shot('14a-paint-area');
  await p.locator('.swatch', { hasText: 'Evergreen Fog' }).click();
  await p.waitForTimeout(600);
  await p.waitForFunction(() => !document.querySelector('.panel-body .spinner'), null, { timeout: 30000 });
  await p.waitForTimeout(500);
  await shot('14b-paint');
  // Erase a stroke across the smoke detector area, then check it re-renders.
  await p.getByTestId('paint-tool-erase').click();
  const cv = await p.getByTestId('canvas').boundingBox();
  await p.mouse.move(cv.x + cv.width * 0.55, cv.y + cv.height * 0.3);
  await p.mouse.down();
  await p.mouse.move(cv.x + cv.width * 0.6, cv.y + cv.height * 0.35, { steps: 6 });
  await p.mouse.up();
  await p.waitForTimeout(600);
  await p.waitForFunction(() => !document.querySelector('.panel-body .spinner'), null, { timeout: 30000 });
  await shot('14c-paint-erased');
  await p.getByTestId('paint-tool-none').click();
  // Tinker quickly (this used to lose the colour): several sensitivity changes in a row.
  const slider = p.getByTestId('paint-tolerance');
  for (const v of ['0.4', '0.8', '0.5', '0.7', '0.6']) {
    await slider.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    await p.waitForTimeout(120);
  }
  await p.waitForTimeout(600);
  await p.waitForFunction(() => !document.querySelector('.panel-body .spinner'), null, { timeout: 60000 });
  await p.waitForTimeout(400);
  const ok = await p.evaluate(async () => {
    const img = document.querySelector('.wall-img');
    return img && img.src.startsWith('blob:') && img.naturalWidth > 0;
  });
  console.log('   painted image present after tinkering:', ok);
  // Ceiling + baseboard as separate surfaces.
  await p.getByTestId('add-surface').click();
  await p.getByTestId('add-ceiling').click();
  await p.waitForSelector('[data-testid=save-surface]');
  await p.waitForTimeout(400);
  await shot('14c2-ceiling-outline');
  await p.getByTestId('save-surface').click();
  await p.locator('.swatch', { hasText: 'Extra White' }).click();
  await p.getByTestId('add-surface').click();
  await p.getByTestId('add-baseboard').click();
  await p.waitForSelector('[data-testid=save-surface]');
  await p.getByTestId('save-surface').click();
  await p.locator('.swatch', { hasText: 'Tricorn Black' }).click();
  await p.waitForTimeout(800);
  await p.waitForFunction(() => !document.querySelector('.panel-body .spinner'), null, { timeout: 60000 });
  await p.waitForTimeout(500);
  await shot('14c3-surfaces');
  await p.getByTestId('surface-wall').click();
  await p.keyboard.press('Escape');
});

await step('extra viewpoint', async () => {
  // Simulate a photo from another spot: the main photo under a known transform.
  const T = [0.85, 0.06, -0.05, 0.85, 180, 150];
  const dataUrl = await p.evaluate(async (T) => {
    const img = new Image(); img.src = '/dev/samples/3.jpg'; await img.decode();
    const c = document.createElement('canvas'); c.width = 1500; c.height = 2000;
    const x = c.getContext('2d'); x.fillStyle = '#2a2a2a'; x.fillRect(0, 0, c.width, c.height);
    x.setTransform(...T); x.drawImage(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.9);
  }, T);
  await p.getByTestId('add-vantage').click();
  await p.getByTestId('library-input').setInputFiles({ name: 'view2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
  await p.waitForSelector('text=Match points');
  await p.waitForTimeout(500);
  const quad = [[90, 560], [900, 240], [900, 1960], [105, 1440]];
  for (let i = 0; i < 4; i++) {
    const [qx, qy] = quad[i];
    await dragStagePoint(1, `new-pt-${i}`, T[0] * qx + T[2] * qy + T[4], T[1] * qx + T[3] * qy + T[5]);
  }
  await shot('14e-vantage-match');
  const fit = await p.locator('text=Fit:').textContent();
  console.log('   ', fit);
  await p.getByTestId('next').click();
  await p.waitForSelector('text=Does it line up?');
  await p.waitForTimeout(500);
  await shot('14f-vantage-check');
  await p.getByTestId('save').click();
  await p.waitForSelector('.fullscreen-editor', { state: 'detached' });
  await p.waitForTimeout(800);
  await p.waitForFunction(() => !document.querySelector('.hud-top .spinner'), null, { timeout: 30000 });
  await p.waitForTimeout(500);
  await shot('14g-vantage-arrange');
  await p.getByTestId('mode-photo').click();
  await p.waitForTimeout(500);
});

await step('grid', async () => {
  await p.getByTestId('toggle-grid').click();
  await p.waitForTimeout(300);
  await shot('14h-grid');
});

await step('straight-on toggle', async () => {
  await p.getByTestId('mode-straight').click();
  await p.waitForTimeout(800);
  await shot('14d-straight');
  await p.getByTestId('mode-photo').click();
  await p.waitForTimeout(800);
  await p.getByTestId('toggle-grid').click();
});

await step('export', async () => {
  await p.getByTestId('tool-export').click();
  await p.locator('button', { hasText: 'Preview' }).click();
  await p.waitForSelector('[data-testid=panel-export] img', { timeout: 30000 });
  await shot('15-export');
});

await step('3D view', async () => {
  await p.keyboard.press('Escape');
  await p.getByTestId('tool-3d').click();
  await p.waitForSelector('[data-testid=three-host] canvas', { timeout: 30000 });
  await p.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  await shot('16a-3d-front');
  await p.locator('button', { hasText: 'From the left' }).click();
  await p.waitForTimeout(1200);
  await shot('16b-3d-left');
  const dl = p.waitForEvent('download', { timeout: 60000 });
  await p.locator('.fullscreen-editor [data-testid=share-ar]').click();
  const file = await dl;
  const path = `${OUT}/gallery.usdz`;
  await file.saveAs(path);
  console.log('   usdz saved:', file.suggestedFilename());
  await p.locator('[aria-label="Close 3D view"]').click();
});

await step('tray has frames only', async () => {
  await p.getByTestId('tool-inventory').click();
  const hasPicturesTab = await p.locator('[data-testid=panel-inventory] .segmented button', { hasText: 'Pictures' }).count();
  if (hasPicturesTab) throw new Error('tray still shows pictures');
  await shot('15b-tray');
});

await step('persistence', async () => {
  await p.reload();
  await p.waitForSelector('[data-testid=placed-item]', { timeout: 10000 });
  const n = await p.getByTestId('placed-item').count();
  console.log('items after reload:', n);
  await shot('16-reload');
});

// Phone-size sanity check
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(400);
await shot('17-phone');

console.log('errors:', errors.length ? errors : 'none');
await b.close();
