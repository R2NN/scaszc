import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Read-only UI regression: pause the clock, then compare geographic marker
// projections through camera changes. No shift operations are submitted.
const require = createRequire(process.env.BEEGO_QA_MODULES
  ? resolve(process.env.BEEGO_QA_MODULES, 'package.json')
  : new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const base = process.env.BEEGO_QA_URL || 'http://127.0.0.1:4186';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw new Error('Use a local test server.');
const output = resolve(process.env.BEEGO_QA_OUTPUT || '../docs/evidence/shift-marker-anchors');
await mkdir(output, { recursive: true });
const before = await (await fetch(`${base}/api/shifts?regionId=moscow&date=2026-08-17`)).json();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const points = () => page.locator('.shift-map-crew-marker').evaluateAll(elements => elements.map(element => {
  const rect = element.getBoundingClientRect();
  return { id: element.firstElementChild.getAttribute('aria-label'), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}));
function assertProjection(previous, current, factor, label) {
  assert.equal(current.length, previous.length, label);
  const byId = new Map(current.map(point => [point.id, point]));
  const anchor = previous[0], nextAnchor = byId.get(anchor.id);
  for (const point of previous) {
    const next = byId.get(point.id);
    assert.ok(next, point.id);
    const error = Math.hypot((next.x - nextAnchor.x) - factor * (point.x - anchor.x), (next.y - nextAnchor.y) - factor * (point.y - anchor.y));
    // MapLibre rounds DOM anchors to CSS pixels; differencing and doubling can add up to four pixels.
    assert.ok(error < 4, `${label}: ${point.id} displaced by ${error.toFixed(2)}px`);
  }
}
try {
  await page.goto(base);
  await page.locator('.route-card-head').first().waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Ход смены', exact: true }).click();
  await page.locator('.shift-map-crew-marker').first().waitFor({ timeout: 60000 });
  await page.getByRole('slider', { name: 'Время смены', exact: true }).evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '808');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('.shift-playback-controls>b')?.textContent === '13:28');
  await page.getByRole('button', { name: 'Воспроизвести', exact: true }).waitFor();
  await page.waitForTimeout(1200);
  let current = await points();
  assert.ok(current.length > 20, `Expected many crews, got ${current.length}`);
  assert.equal(new Set(current.map(point => point.id)).size, current.length);
  for (let step = 0; step < 6; step++) {
    const previous = current;
    await page.getByRole('button', { name: 'Уменьшить масштаб', exact: true }).click();
    await page.waitForTimeout(750);
    current = await points();
    assertProjection(previous, current, 0.5, `Zoom out ${step + 1}`);
  }
  assert.equal(await page.locator('.shift-map-crew-marker.is-displaced').count(), 0);
  assert.ok(await page.locator('.shift-map-crew-marker').evaluateAll(elements => elements.every(element => getComputedStyle(element, '::before').content === 'none')));
  await page.screenshot({ path: resolve(output, 'shift-country-zoom.png'), animations: 'disabled' });
  const beforePan = current;
  const canvas = await page.locator('.maplibregl-canvas').boundingBox();
  await page.mouse.move(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.7 + 120, canvas.y + canvas.height * 0.35 + 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  current = await points();
  assertProjection(beforePan, current, 1, 'Pan');
  assert.ok(Math.hypot(current[0].x - beforePan[0].x, current[0].y - beforePan[0].y) > 30, 'Pan must actually move the camera');
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(700);
  const resized = await points();
  assertProjection(current, resized, 1, 'Resize');
  current = resized;
  for (let step = 0; step < 6; step++) {
    const previous = current;
    await page.getByRole('button', { name: 'Увеличить масштаб', exact: true }).click();
    await page.waitForTimeout(750);
    current = await points();
    assertProjection(previous, current, 2, `Zoom in ${step + 1}`);
  }
  await page.getByRole('button', { name: 'Показать все точки', exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(output, 'shift-city-zoom.png'), animations: 'disabled' });
  const beforeWheel = await points();
  const mapBounds = await page.locator('.maplibregl-canvas').boundingBox();
  await page.mouse.move(mapBounds.x + mapBounds.width * 0.7, mapBounds.y + mapBounds.height * 0.35);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(1400);
  const afterWheel = await points();
  let dot = 0, norm = 0;
  for (let i = 1; i < beforeWheel.length; i++) {
    const dx = beforeWheel[i].x - beforeWheel[0].x, dy = beforeWheel[i].y - beforeWheel[0].y;
    dot += dx * (afterWheel[i].x - afterWheel[0].x) + dy * (afterWheel[i].y - afterWheel[0].y);
    norm += dx ** 2 + dy ** 2;
  }
  const wheelScale = dot / norm;
  assert.ok(wheelScale > 0 && wheelScale < 0.99, 'Wheel must zoom out');
  assertProjection(beforeWheel, afterWheel, wheelScale, 'Wheel zoom');
  await page.locator('.shift-crew').first().click();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('.shift-map-crew-marker').count(), 1);
  assert.equal(await page.locator('.shift-map-crew.is-focused').count(), 1);
  await page.getByRole('button', { name: 'Снять выбор бригады', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal((await points()).length, beforePan.length);
  assert.deepEqual(errors, []);
  assert.deepEqual(await (await fetch(`${base}/api/shifts?regionId=moscow&date=2026-08-17`)).json(), before);
  console.log(`PASS: ${beforePan.length} crews; six zoom-outs, six zoom-ins, wheel zoom, pan, resize, list selection; no radial offsets, no JS errors, shift unchanged.`);
} finally {
  await browser.close();
}
