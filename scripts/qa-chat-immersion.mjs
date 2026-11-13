#!/usr/bin/env node
/**
 * Mobile immersion browser proof against a running development server.
 * Network-owned fixtures supply synthetic TLE and AIS observations; the real
 * parsers, SGP4, Cesium, layers, Cockpit controller and shell facade run.
 * Selection is arranged through the layers' public selectors. Entry, optics,
 * look, signals, radar and exit are driven through rendered touch controls.
 * This proves fixture-backed behavior, not live AIS credentials or orbit accuracy.
 *
 * QA_BASE_URL=http://127.0.0.1:4173 QA_SHOTS_DIR=qa-artifacts/mobile-immersion \
 *   node scripts/qa-chat-immersion.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE = process.env.QA_BASE_URL || 'http://127.0.0.1:4173';
const origin = new URL(BASE).origin;
const shots = path.resolve(
  process.env.QA_SHOTS_DIR || 'qa-artifacts/mobile-immersion',
);
fs.mkdirSync(shots, { recursive: true });
const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath());
const browser = await puppeteer.launch({
  headless: !process.argv.includes('--headful'),
  executablePath,
  protocolTimeout: 120_000,
  args: [
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--no-sandbox',
  ],
});
const report = {
  fixture:
    'Synthetic TLE/AIS observations; real shipped layers, SGP4, Cesium, controller and facade. No live AIS claim.',
  checks: [],
  pageErrors: [],
  consoleErrors: [],
  fixtureRequests: {},
};
const check = (name, ok, detail = null) => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`,
  );
};
const snapshot = (page) =>
  page.evaluate(() => globalThis.__chatView.kernel.snapshot().stage.immersion);
const waitState = (page, predicate, ...args) =>
  page.waitForFunction(predicate, { timeout: 45_000, polling: 100 }, ...args);
const shot = (page, name) =>
  page.screenshot({ path: path.join(shots, `${name}.png`) });

function epoch(now) {
  const year = now.getUTCFullYear();
  const days = (now.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  return `${String(year % 100).padStart(2, '0')}${days.toFixed(8).padStart(12, '0')}`;
}
const at = epoch(new Date());
const iss = [
  'QA ISS FIXTURE',
  `1 25544U 98067A   ${at}  .00016717  00000-0  10270-3 0  9990`,
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49814310 12345',
].join('\n');
const sentinel = [
  'QA SENTINEL-2A FIXTURE',
  `1 40697U 15028A   ${at}  .00000100  00000-0  10000-4 0  9990`,
  '2 40697  98.5700 247.4627 0006703 130.5360 325.0288 14.30800000 12345',
].join('\n');
const satcat = [
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER',
  'QA ISS FIXTURE,1998-067A,25544,PAY,+,ISS',
  'QA SENTINEL-2A FIXTURE,2015-028A,40697,PAY,+,ESA',
].join('\n');

async function installFixtures(page) {
  // Vite's large module graph stays in Chromium. Only the network domain
  // boundaries owned by this scenario make a round trip through Node.
  const client = await page.createCDPSession();
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: `${origin}/api/*` }],
  });
  client.on('Fetch.requestPaused', (event) => {
    const request = {
      url: () => event.request.url,
      continue: () =>
        client.send('Fetch.continueRequest', { requestId: event.requestId }),
      respond: ({ status = 200, contentType, headers = {}, body = '' }) =>
        client.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: status,
          responseHeaders: Object.entries({
            ...(contentType ? { 'content-type': contentType } : {}),
            ...headers,
          }).map(([name, value]) => ({ name, value: String(value) })),
          body: Buffer.from(body).toString('base64'),
        }),
    };
    const url = new URL(request.url());
    if (url.origin !== origin) return void request.continue().catch(() => {});
    const send = (body, contentType = 'application/json') => {
      report.fixtureRequests[url.pathname] =
        (report.fixtureRequests[url.pathname] || 0) + 1;
      return request
        .respond({
          status: 200,
          contentType,
          headers: { 'x-gev-qa-fixture': 'mobile-immersion-synthetic' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        })
        .catch(() => {});
    };
    if (url.pathname.startsWith('/api/celestrak/')) {
      const group = url.pathname.split('/').at(-1);
      return void send(
        group === 'stations'
          ? `${iss}\n`
          : group === 'resource'
            ? `${sentinel}\n`
            : '',
        'text/plain',
      );
    }
    if (url.pathname.startsWith('/api/celestrak-satcat/'))
      return void send(satcat, 'text/csv');
    if (url.pathname === '/api/vessels') {
      const now = Date.now();
      return void send({
        source: 'QA synthetic AIS fixture',
        status: 'open',
        error: null,
        refreshing: false,
        newestPositionAt: new Date(now).toISOString(),
        lastMessageAt: now,
        rows: [
          {
            mmsi: '211000000',
            name: 'QA NORDIC STAR FIXTURE',
            type: '70',
            destination: 'QA KIEL',
            lat: 54.5,
            lon: 10.2,
            speed: 12,
            course: 95,
            heading: 90,
            last_position_epoch: now / 1000,
          },
          {
            mmsi: '211000001',
            name: 'QA BALTIC TERN FIXTURE',
            type: '30',
            lat: 54.52,
            lon: 10.2,
            speed: 5,
            course: 270,
            heading: 270,
            last_position_epoch: now / 1000,
          },
        ],
      });
    }
    if (url.pathname === '/api/terrain/heights') {
      return void send({
        results: (url.searchParams.get('points') || '')
          .split(';')
          .filter(Boolean)
          .map((point) => {
            const [lon, lat] = point.split(',').map(Number);
            return { lon, lat, elevation: 0, geoid: 0, ellipsoid: 0 };
          }),
      });
    }
    if (url.pathname === '/api/military')
      return void send({
        now: Date.now(),
        ac: [],
        msg: 'QA empty aircraft fixture',
      });
    if (url.pathname === '/api/flights')
      return void send({ now: Date.now(), ac: [], states: [] });
    if (url.pathname === '/api/flights/track') return void send({ path: [] });
    if (url.pathname === '/api/launches') return void send({ results: [] });
    if (url.pathname === '/api/openai/hud-summary')
      return void send({ summary: 'QA immersion fixture' });
    request.continue().catch(() => {});
  });
}

async function tap(page, selector) {
  const point = await page.waitForFunction(
    async (selector) => {
      const el = document.querySelector(selector);
      if (!el?.getClientRects().length || el.disabled) return false;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const before = el.getBoundingClientRect();
      await new Promise(requestAnimationFrame);
      if (!el.isConnected) return false;
      const rect = el.getBoundingClientRect();
      if (
        ['x', 'y', 'width', 'height'].some((key) => rect[key] !== before[key])
      )
        return false;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return el.contains(hit) ? { x, y } : false;
    },
    { timeout: 30_000 },
    selector,
  );
  const { x, y } = await point.jsonValue();
  await point.dispose();
  await page.touchscreen.tap(x, y);
}
async function tapLabel(page, label) {
  const handle = await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('.cv-immersion button')].find(
        (el) =>
          (el.getAttribute('aria-label') === name ||
            el.textContent.trim() === name) &&
          !el.disabled &&
          !el.closest('details:not([open])') &&
          el.getClientRects().length,
      ) || false,
    { timeout: 30_000 },
    label,
  );
  const element = handle.asElement();
  await element.evaluate((el) =>
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
  );
  const hit = await element.evaluate((el, recordExit) => {
    const { x, y, width, height } = el.getBoundingClientRect();
    const target = document.elementFromPoint(x + width / 2, y + height / 2);
    if (recordExit) {
      globalThis.qaExitTouch = null;
      el.addEventListener(
        'click',
        (event) => {
          globalThis.qaExitTouch = event.pointerType;
        },
        { once: true },
      );
    }
    return target === el || el.contains(target);
  }, label.startsWith('Exit '));
  if (!hit) throw new Error(`The visible ${label} button is covered`);
  await element.tap();
  await handle.dispose();
}
async function setSignalsOpen(page, open) {
  const selector = '.cv-immersion-signals';
  const isOpen = await page.evaluate(
    (selector) => Boolean(document.querySelector(selector)?.open),
    selector,
  );
  if (isOpen === open) return;
  await tap(page, `${selector} summary`);
  await page.waitForFunction(
    (selector, open) => document.querySelector(selector)?.open === open,
    { timeout: 10_000 },
    selector,
    open,
  );
}
async function closeTime(page) {
  const open = await page.$eval(
    '.cv-tools [aria-controls="cv-time"]',
    (el) => el.getAttribute('aria-expanded') === 'true',
  );
  if (open) await tap(page, '.cv-tools [aria-controls="cv-time"]');
}

async function layout(page, width, mode) {
  const name = `${width} ${mode}`;
  await setSignalsOpen(page, false);
  const details = await page.evaluate((expectedWidth) => {
    const card = document.querySelector('.cv-immersion');
    const composer = document.querySelector('.cv-composer');
    const rect = composer.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    const controls = [...card.querySelectorAll('button, summary')].filter(
      (el) => el.getClientRects().length,
    );
    const small = controls
      .map((el) => ({
        name: el.getAttribute('aria-label') || el.textContent.trim(),
        w: el.getBoundingClientRect().width,
        h: el.getBoundingClientRect().height,
      }))
      .filter(({ w, h }) => w < 43.5 || h < 43.5);
    const clipped = [card, composer, ...controls]
      .filter((el) => {
        const { left, right } = el.getBoundingClientRect();
        return left < -1 || right > expectedWidth + 1;
      })
      .map((el) => el.getAttribute('aria-label') || el.className);
    const native = document.querySelector('[data-gev-view="cockpit"]');
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    );
    return {
      viewport: innerWidth,
      visualWidth: visualViewport.width,
      scale: visualViewport.scale,
      documentWidth,
      cardWidth: card.clientWidth,
      cardContentWidth: card.scrollWidth,
      cardTop: card.getBoundingClientRect().top,
      globeCenterClear:
        !card.querySelector('details[open]') &&
        card.getBoundingClientRect().top >= innerHeight / 2,
      clipped,
      // The decorative fade behind .cv-bottom is clipped by the page. Measure
      // the actual scrollable document, card and controls rather than the fade.
      overflow:
        Math.abs(innerWidth - expectedWidth) > 1 ||
        Math.abs(visualViewport.width - expectedWidth) > 1 ||
        Math.abs(visualViewport.scale - 1) > 0.01 ||
        documentWidth > expectedWidth + 1 ||
        card.scrollWidth > card.clientWidth + 1 ||
        clipped.length > 0,
      small,
      nativeHidden:
        Boolean(native) && getComputedStyle(native).display === 'none',
      composerUncovered: Boolean(hit && composer.contains(hit)),
    };
  }, width);
  check(`${name}: no horizontal overflow`, !details.overflow, details);
  check(
    `${name}: visible controls have 44 px touch targets`,
    details.small.length === 0,
    details.small,
  );
  check(
    `${name}: native HUD stays hidden and composer remains reachable`,
    details.nativeHidden && details.composerUncovered,
    details,
  );
  if (width === 390)
    check(
      `${name}: default controls leave the globe center clear`,
      details.globeCenterClear,
      details,
    );
}

async function setSatellite(page) {
  console.log('Arranging the real satellite layer with owned observations…');
  const arranged = await page.evaluate(async () => {
    const { dataManager } = globalThis.__chatView.components.data;
    await dataManager.setEnabled('satellites', true, { origin: 'user' });
    await dataManager.refreshLayer('satellites');
    return dataManager.layers
      .get('satellites')
      .module.trackById(40697, { origin: 'user' });
  });
  if (!arranged)
    throw new Error(
      'The real satellite layer could not track the owned TLE fixture',
    );
  await waitState(
    page,
    () =>
      globalThis.__chatView.kernel.snapshot().stage.immersion?.entry?.id ===
      '40697',
  );
  await closeTime(page);
}

async function entryProof(page, width, label) {
  await page.waitForSelector('.cv-immersion-enter', { visible: true });
  const entry = await page.$eval('.cv-immersion-enter', (el) => {
    const rect = el.getBoundingClientRect();
    return {
      text: el.textContent.trim(),
      accessible: el.getAttribute('aria-label'),
      enabled: !el.disabled,
      width: rect.width,
      height: rect.height,
    };
  });
  check(
    `${width}: selected subject exposes an accessible ${label} entry`,
    entry.text === label &&
      entry.accessible === label &&
      entry.enabled &&
      entry.width >= 43.5 &&
      entry.height >= 43.5,
    entry,
  );
}

async function runPhone(width) {
  console.log(`Opening ${width} px mobile chat…`);
  const page = await browser.newPage();
  page.on('pageerror', (error) =>
    report.pageErrors.push({ width, message: error.message }),
  );
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().startsWith('Failed to load resource:')
    )
      report.consoleErrors.push({
        width,
        message: message.text().slice(0, 300),
      });
  });
  await page.setViewport({
    width,
    height: width === 320 ? 568 : 664,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  await installFixtures(page);
  try {
    await page.goto(`${BASE}/?ui=chat&lang=en`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await page.waitForFunction(
      () =>
        globalThis.__chatView?.kernel &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 120_000 },
    );
    console.log(`${width} px: globe and kernel connected`);
    await page.evaluate(async () => {
      await globalThis.__chatView.kernel.act('newSession');
      const label = document.createElement('div');
      label.id = 'qa-immersion-fixture-label';
      label.textContent = 'QA FIXTURES: synthetic TLE + AIS observations';
      label.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:9999;background:#ffe08a;color:#111;font:10px/18px system-ui;text-align:center;pointer-events:none';
      document.body.appendChild(label);
    });
    await waitState(
      page,
      () =>
        globalThis.__chatView.components.data.dataManager.getEnabledLayerIds()
          .size === 0,
    );
    await setSatellite(page);
    await entryProof(page, width, 'ORBIT');

    // A rendered button retained from the previous sample must not enter a
    // different/dropped subject before the next snapshot removes the button.
    await page.evaluate(() => {
      const button = document.querySelector('.cv-immersion-enter');
      globalThis.__chatView.components.data.dataManager.layers
        .get('satellites')
        .module.stopTracking({ origin: 'user' });
      button.click();
    });
    await waitState(
      page,
      () => !globalThis.__chatView.kernel.snapshot().stage.immersion.entry,
    );
    check(
      `${width}: a retained entry refuses a dropped satellite`,
      !(await snapshot(page)).active,
    );
    await setSatellite(page);
    const beforeFov = await page.evaluate(
      () => globalThis.__chatView.components.scene.viewer.camera.frustum.fov,
    );
    await tap(page, '.cv-immersion-enter');
    await waitState(
      page,
      () =>
        globalThis.__chatView.kernel.snapshot().stage.immersion?.active &&
        globalThis.__chatView.kernel.snapshot().stage.immersion?.subjectKind ===
          'satellite',
    );
    check(
      `${width}: ORBIT enters the real satellite camera`,
      await page.evaluate(
        () =>
          document.body.classList.contains('cockpit-orbit') &&
          !globalThis.__chatView.components.scene.viewer.scene
            .screenSpaceCameraController.enableInputs,
      ),
    );
    const cloned = await page.evaluate(() => {
      const state = globalThis.__chatView.kernel.snapshot().stage.immersion;
      return JSON.stringify(state) === JSON.stringify(structuredClone(state));
    });
    check(`${width}: immersive port snapshot is cloneable`, cloned);
    await tapLabel(page, 'Zoom in');
    await waitState(
      page,
      () =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.orbital?.zoom >
        1,
    );
    await tapLabel(page, 'Look right');
    await waitState(
      page,
      () =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.orbital?.look
          .offset,
    );
    await tapLabel(page, 'Return the view to nadir');
    await waitState(
      page,
      () =>
        !globalThis.__chatView.kernel.snapshot().stage.immersion.orbital?.look
          .offset,
    );
    check(
      `${width}: orbital zoom, look and NADIR use the shared controller`,
      true,
    );
    const sensorBefore = (await snapshot(page)).orbital.zoom;
    await tapLabel(page, 'Zoom to the imaging sensor swath');
    await waitState(
      page,
      (before) =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.orbital
          ?.zoom !== before,
      sensorBefore,
    );
    check(
      `${width}: bundled Sentinel sensor drives SENSOR zoom`,
      (await snapshot(page)).orbital.zoom > 1,
    );

    await setSignalsOpen(page, true);
    const ride = (await snapshot(page)).signals.find(
      (row) => row.target?.layerId === 'satellites',
    );
    if (!ride)
      throw new Error(
        'The owned second satellite did not produce a real Live Signals row',
      );
    await tapLabel(page, ride.target.label);
    await waitState(
      page,
      (id) =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.subject?.id ===
        id,
      ride.target.id,
    );
    await setSignalsOpen(page, true);
    await tapLabel(page, 'Previous');
    await waitState(
      page,
      () =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.subject?.id ===
        '40697',
    );
    check(
      `${width}: Live Signals rides another real catalog object and returns`,
      true,
    );
    await layout(page, width, 'orbital');
    await page.waitForSelector('.cv-toast', { hidden: true });
    await shot(page, `${width}-orbital-fixtures`);
    await tapLabel(page, 'Exit orbital view');
    await waitState(
      page,
      () => !globalThis.__chatView.kernel.snapshot().stage.immersion.active,
    );
    check(
      `${width}: orbital exit unlocks inputs and restores field of view`,
      await page.evaluate(
        (fov) =>
          globalThis.qaExitTouch === 'touch' &&
          globalThis.__chatView.components.scene.viewer.scene
            .screenSpaceCameraController.enableInputs &&
          Math.abs(
            globalThis.__chatView.components.scene.viewer.camera.frustum.fov -
              fov,
          ) < 1e-8,
        beforeFov,
      ),
    );

    const selected = await page.evaluate(async () => {
      const { dataManager } = globalThis.__chatView.components.data;
      dataManager.layers
        .get('satellites')
        .module.stopTracking({ origin: 'user' });
      await dataManager.setEnabled('satellites', false, { origin: 'user' });
      await dataManager.setEnabled('ais-live-vessels', true, {
        origin: 'user',
      });
      await dataManager.refreshLayer('ais-live-vessels');
      return dataManager.layers
        .get('ais-live-vessels')
        .module.selectById('211000000');
    });
    if (!selected)
      throw new Error(
        'The real vessel layer did not ingest/select the owned AIS fixture',
      );
    await waitState(
      page,
      () =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.entry?.kind ===
        'vessel',
    );
    await closeTime(page);
    await entryProof(page, width, 'BRIDGE');
    await tap(page, '.cv-immersion-enter');
    await waitState(
      page,
      () =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.active &&
        globalThis.__chatView.kernel.snapshot().stage.immersion.subjectKind ===
          'vessel',
    );
    check(
      `${width}: BRIDGE enters the real selected vessel camera`,
      await page.evaluate(
        () =>
          document.body.classList.contains('cockpit-bridge') &&
          !globalThis.__chatView.components.scene.viewer.scene
            .screenSpaceCameraController.enableInputs,
      ),
    );
    await tapLabel(page, 'Look left');
    await waitState(
      page,
      () =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.bridge?.look
          .offset,
    );
    await tapLabel(page, 'LOOK AHEAD');
    await waitState(
      page,
      () =>
        !globalThis.__chatView.kernel.snapshot().stage.immersion.bridge?.look
          .offset,
    );
    const range = (await snapshot(page)).bridge.rangeLabel;
    await tapLabel(page, `Radar range ${range}. Select for the next range.`);
    await waitState(
      page,
      (before) =>
        globalThis.__chatView.kernel.snapshot().stage.immersion.bridge
          ?.rangeLabel !== before,
      range,
    );
    const shipState = await snapshot(page);
    check(
      `${width}: bridge look and radar range use real AIS-backed controls`,
      shipState.bridge.contacts.some((row) => row.id === '211000001'),
    );
    await layout(page, width, 'bridge');
    await shot(page, `${width}-bridge-fixtures`);
    await tapLabel(page, 'Exit bridge view');
    await waitState(
      page,
      () =>
        !globalThis.__chatView.kernel.snapshot().stage.immersion.active &&
        globalThis.__chatView.components.scene.viewer.scene
          .screenSpaceCameraController.enableInputs,
    );
    check(
      `${width}: bridge exit returns to the vessel's map view and unlocks inputs`,
      await page.evaluate(
        () =>
          globalThis.qaExitTouch === 'touch' &&
          !document.body.classList.contains('cockpit-bridge') &&
          globalThis.__chatView.kernel.snapshot().stage.immersion.entry?.id ===
            '211000000',
      ),
    );
  } catch (error) {
    await shot(page, `${width}-failure`).catch(() => {});
    report.failureState = await page
      .evaluate(() => ({
        url: location.href,
        loader: document.querySelector('#loading-screen')?.textContent,
        body: document.body.className,
        enabled: [
          ...(globalThis.__chatView?.components.data.dataManager.getEnabledLayerIds() ||
            []),
        ],
        immersion: globalThis.__chatView?.kernel.snapshot().stage.immersion,
        exitTouch: globalThis.qaExitTouch,
        resources: performance
          .getEntriesByType('resource')
          .slice(-8)
          .map((resource) => ({
            url: resource.name,
            duration: resource.duration,
          })),
      }))
      .catch(() => null);
    throw error;
  } finally {
    await page.close();
  }
}

console.log(report.fixture);
try {
  for (const width of [390, 320]) await runPhone(width);
  check(
    'no uncaught browser errors',
    report.pageErrors.length === 0,
    report.pageErrors,
  );
  check(
    'no application console errors',
    report.consoleErrors.length === 0,
    report.consoleErrors,
  );
} catch (error) {
  check('browser proof completed', false, error.stack || error.message);
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(shots, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
const failed = report.checks.filter((item) => !item.ok);
console.log(
  `IMMERSION: ${failed.length ? 'FAIL' : 'PASS'} (${report.checks.length} checks, ${failed.length} failed). Screenshots: ${shots}`,
);
if (failed.length) process.exitCode = 1;
