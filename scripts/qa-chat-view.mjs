#!/usr/bin/env node
/**
 * Browser proof for the chat view (src/chatView, src/ui/views/chatView): the
 * switch between it and the panels on one globe, its timeline, the answer's
 * credit line, and the composer's keyboard and touch behavior, on a desktop
 * window and a phone. Run it against a dev server:
 *
 *   npm run dev            # http://localhost:4173
 *   npm run qa:chat-view   # QA_BASE_URL=… for another server
 *   npm run qa:chat-view -- --focused-timeline  # one phone boot
 *   npm run qa:chat-view -- --focused-cctv      # device vs map location
 *
 * Owned feed fixtures and unavailable model endpoints keep this suite
 * deterministic. Provider transport parity has separate unit coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const shotsDir =
  process.env.QA_SHOTS_DIR || path.join(repoRoot, 'qa-shots', 'chat-view');
const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const headful = process.argv.includes('--headful');
const focused = process.argv.includes('--focused-timeline');
const cctvOnly = process.argv.includes('--focused-cctv');
const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (await puppeteer.executablePath().catch(() => null));
if (!executablePath || !fs.existsSync(executablePath))
  throw new Error('Puppeteer Chrome for Testing is unavailable');
fs.mkdirSync(shotsDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  executablePath,
  protocolTimeout: 300_000,
  // Metal is macOS-only; elsewhere WebGL runs on SwiftShader.
  args: [
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--no-sandbox',
  ],
});
const failures = [];
const errors = [];
const checks = [];
let activePage = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, passed, detail = '') => {
  checks.push({ name, passed: Boolean(passed), detail });
  console.log(
    `  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures.push(name);
};
const shot = (page, name) =>
  page.screenshot({ path: path.join(shotsDir, `${name}.png`) });

const DESK = { width: 1440, height: 900 };
const PHONE = {
  width: 375,
  height: 812,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const TIME = '.cv-tools [aria-controls="cv-time"]';
const SCRUB = '#cv-time input[type="range"]';
const MIAMI = {
  id: 'qa-miami',
  name: 'QA Miami camera',
  lat: 25.7617,
  lon: -80.1918,
};
const KANEPI = {
  id: 'qa-kanepi',
  name: 'QA Kanepi camera',
  lat: 57.98,
  lon: 26.63,
};
const OFFLINE_MIAMI = {
  id: 'qa-miami-offline',
  name: 'QA offline Miami camera',
  lat: MIAMI.lat,
  lon: MIAMI.lon - 0.002,
};
const PALM_BEACH = { lat: 26.67, lon: -80.36 };
const PALM_FIRST = {
  id: 'qa-palm-first',
  name: 'QA Palm Beach first',
  ...PALM_BEACH,
};
const PALM_OFFLINE = {
  ...PALM_FIRST,
  id: 'qa-palm-offline',
  name: 'QA Palm Beach offline',
  lon: -80.35,
};
const PALM_SECOND = {
  ...PALM_FIRST,
  id: 'qa-palm-second',
  name: 'QA Palm Beach second',
  lon: -80.3,
};
const CCTV_CAMERAS = [
  MIAMI,
  PALM_FIRST,
  KANEPI,
  PALM_OFFLINE,
  PALM_SECOND,
  OFFLINE_MIAMI,
].map((camera) => ({
  ...camera,
  provider: 'QA CCTV fixture',
  sourceKind: 'synthetic',
  feedType: 'image',
  url: `/api/cctv/frame/${camera.id}`,
}));

// Owned boundary fixtures make this a repeatable UI/clock proof. The source
// adapters, layer manager, query engine, kernel and Vue views run unchanged.
// This suite does not claim live-provider accuracy or paid model coverage.
const fixtureDay = (offset) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const installFixtures = async (page) => {
  const state = { weatherHold: null };
  page.__chatFixtures = state;
  // Pause only the boundaries this suite owns; Vite's module graph should
  // not make a round trip through Node for every application module.
  const client = await page.createCDPSession();
  await client.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/*' },
      { urlPattern: '*photon.komoot.io/*' },
      { urlPattern: '*earthquake.usgs.gov/*' },
    ],
  });
  client.on('Fetch.requestPaused', async (event) => {
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
    const json = (body, status = 200) =>
      request
        .respond({
          status,
          contentType: 'application/json',
          headers: {
            'access-control-allow-origin': '*',
            'x-gev-qa-fixture': 'chat-view',
          },
          body: JSON.stringify(body),
        })
        .catch(() => {});
    const place = url.searchParams.get('address') || url.searchParams.get('q');
    if (place?.toLowerCase() === 'palm beach county') {
      if (
        url.pathname === '/api/google/geocode' ||
        url.pathname === '/api/geocode'
      ) {
        await json({
          status: 'OK',
          results: [
            {
              formatted_address: 'Palm Beach County, FL, USA',
              geometry: {
                location: { lat: PALM_BEACH.lat, lng: PALM_BEACH.lon },
              },
              types: ['administrative_area_level_2'],
            },
          ],
        });
        return;
      }
      if (url.hostname === 'photon.komoot.io') {
        await json({
          features: [
            {
              geometry: {
                type: 'Point',
                coordinates: [PALM_BEACH.lon, PALM_BEACH.lat],
              },
              properties: {
                name: 'Palm Beach County',
                state: 'Florida',
                countrycode: 'US',
                type: 'county',
              },
            },
          ],
        });
        return;
      }
    }
    if (
      /\/api\/(?:openai\/chat|gemini\/chat|realtime\/token)$/.test(url.pathname)
    ) {
      await json(
        { error: 'QA uses the deterministic planner', code: 'API_KEY_MISSING' },
        503,
      );
      return;
    }
    if (
      url.hostname === 'earthquake.usgs.gov' &&
      /all_(?:day|week)\.geojson$/.test(url.pathname)
    ) {
      const day = url.pathname.includes('all_day');
      const ages = day ? [2, 8, 20] : [2, 8, 20, 48, 120, 160];
      await json({
        type: 'FeatureCollection',
        metadata: { generated: Date.now(), title: 'QA earthquake fixture' },
        features: ages.map((age, i) => ({
          type: 'Feature',
          id: `qa-quake-${age}`,
          properties: {
            mag: 4.6 + (i % 3) * 0.3,
            place: `QA event ${age} hours ago`,
            time: Date.now() - age * 3_600_000,
          },
          geometry: { type: 'Point', coordinates: [139 + i, 35 + i * 0.1, 10] },
        })),
      });
      return;
    }
    if (url.pathname === '/api/weather-daily') {
      if (state.weatherHold) {
        const hold = state.weatherHold;
        state.weatherHold = null;
        hold.started.resolve();
        await hold.release.promise;
      }
      await json({
        today: fixtureDay(0),
        timezone: 'America/New_York',
        days: Array.from({ length: 15 }, (_, i) => ({
          date: fixtureDay(i - 7),
          weatherCode: i % 2 ? 63 : 1,
          highC: 28,
          lowC: 22,
          precipitationMm: i % 2 ? 8 : 0,
          gustKph: 20,
        })),
      });
      return;
    }
    if (url.pathname === '/api/weather/manifest') {
      const product = url.searchParams.get('product');
      const end = Math.floor(Date.now() / 900_000) * 900_000;
      const times = Array.from({ length: 9 }, (_, i) =>
        new Date(end - (8 - i) * 900_000).toISOString(),
      );
      await json({
        schemaVersion: 1,
        product,
        bounds: { west: -180, east: 180, south: -85, north: 85 },
        times,
        latest: times.at(-1),
        tileSize: 256,
        maxLevel: 6,
        tilingScheme: 'geographic',
        source: 'QA observed frames',
        fetchedAt: Date.now(),
      });
      return;
    }
    if (url.pathname === '/api/cctv/sources') {
      await json({ sources: CCTV_CAMERAS, trimmedPacks: [] });
      return;
    }
    if (url.pathname === '/api/cctv/health') {
      await json({
        cameras: CCTV_CAMERAS.map(({ id, name }) => ({
          id,
          label: name,
          status: 'ok',
          sourceKind: 'synthetic',
        })),
      });
      return;
    }
    if (
      [OFFLINE_MIAMI.id, PALM_OFFLINE.id].some(
        (id) => url.pathname === `/api/cctv/frame/${id}`,
      )
    ) {
      await request.respond({ status: 204 }).catch(() => {});
      return;
    }
    const cameraFrame = CCTV_CAMERAS.some(
      ({ url: frame }) => url.pathname === frame,
    );
    if (cameraFrame || /^\/api\/weather\/(?:image|tile)$/.test(url.pathname)) {
      await request
        .respond({
          status: 200,
          contentType: 'image/png',
          ...(cameraFrame && {
            headers: { 'x-cctv-source': 'upstream-image' },
          }),
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
            'base64',
          ),
        })
        .catch(() => {});
      return;
    }
    if (/^\/api\/celestrak\//.test(url.pathname)) {
      const body =
        'ISS (ZARYA)\n1 25544U 98067A   24001.50000000  .00016717  00000-0  30270-3 0  9994\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579432414\n';
      await request
        .respond({ status: 200, contentType: 'text/plain', body })
        .catch(() => {});
      return;
    }
    if (/^\/api\/celestrak-satcat\//.test(url.pathname)) {
      await request
        .respond({
          status: 200,
          contentType: 'text/csv',
          body: 'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER\nISS (ZARYA),1998-067A,25544,PAY,+,ISS\n',
        })
        .catch(() => {});
      return;
    }
    if (url.pathname === '/api/flights') {
      await json({
        time: Math.floor(Date.now() / 1000),
        states: [
          [
            'a00001',
            'QATST1',
            'United States',
            Math.floor(Date.now() / 1000),
            Math.floor(Date.now() / 1000),
            -97,
            31,
            9000,
            false,
            180,
            90,
            0,
            null,
            9000,
            '1200',
            false,
            0,
          ],
        ],
      });
      return;
    }
    if (url.pathname === '/api/military') {
      await json({ ac: [], now: Date.now() / 1000, messages: 0 });
      return;
    }
    await request.continue().catch(() => {});
  });
};

const open = async (viewport) => {
  const page = await browser.newPage();
  activePage = page;
  page.__qaPending = new Map();
  page.on('request', (request) => {
    const url = new URL(request.url());
    page.__qaPending.set(request, `${url.origin}${url.pathname}`);
  });
  page.on('requestfinished', (request) => page.__qaPending.delete(request));
  page.on('requestfailed', (request) => page.__qaPending.delete(request));
  page.setDefaultNavigationTimeout(120_000);
  await page.setViewport(viewport);
  await installFixtures(page);
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
  page.on('console', (message) => {
    if (message.type() === 'error' && /chat view/i.test(message.text()))
      errors.push(message.text().slice(0, 200));
  });
  return page;
};
const boot = async (page, address) => {
  await page.goto(`${BASE}${address}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    {
      timeout: 120_000,
    },
  );
  await sleep(1500);
};
const kernelUp = (page) =>
  page
    .waitForFunction(() => globalThis.__chatView?.kernel, { timeout: 60_000 })
    .catch(() => {});
const fresh = async (page, address) => {
  const script = await page.evaluateOnNewDocument(() => localStorage.clear());
  try {
    await boot(page, address);
  } finally {
    await page.removeScriptToEvaluateOnNewDocument(script.identifier);
  }
};
const shown = (page, selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      getComputedStyle(el).visibility !== 'hidden'
    );
  }, selector);
const snapshot = (page) =>
  page.evaluate(() => globalThis.__chatView.kernel.snapshot());
const act = (page, name, ...args) =>
  page.evaluate(
    (intent, values) => globalThis.__chatView.kernel.act(intent, ...values),
    name,
    args,
  );
// Asks, and resolves once the new question has answered.
const ask = async (page, question) => {
  const before = (await snapshot(page)).session?.turns.length ?? 0;
  await page.evaluate((text) => {
    globalThis.__chatView.kernel.act('ask', text);
  }, question);
  await page
    .waitForFunction(
      (count) => {
        const turns =
          globalThis.__chatView.kernel.snapshot().session?.turns || [];
        return turns.length > count && turns.at(-1).status !== 'running';
      },
      { timeout: 90_000, polling: 250 },
      before,
    )
    .catch(() => {});
  const turn = (await snapshot(page)).session?.turns.at(-1);
  console.log(`         “${question}” → ${turn?.answer?.say ?? turn?.status}`);
  return turn;
};
const timeButton = (page) =>
  page.$eval(TIME, (button) => ({
    // The label on screen: the short one below 390px, the full one above.
    text: [...button.querySelectorAll('.cv-time-label')]
      .find((label) => getComputedStyle(label).display !== 'none')
      ?.textContent.trim(),
    expanded: button.getAttribute('aria-expanded'),
    name: button.getAttribute('aria-label'),
  }));
const inChatView = (page) =>
  page.evaluate(() => document.body.classList.contains('chat-view-mode'));

const prepareLayers = async (page, ids) => {
  await act(page, 'newSession');
  await page.waitForFunction(
    () =>
      [
        ...globalThis.__chatView.components.data.dataManager.getEnabledLayerIds(),
      ].filter(
        (id) =>
          globalThis.__chatView.components.data.dataManager
            .getAll()
            .find((row) => row.id === id)?.showInTogglePanel !== false,
      ).length === 0,
    { timeout: 15_000 },
  );
  for (const id of ids) await act(page, 'toggleLayer', id);
  await page.waitForFunction(
    (wanted) => {
      const time = globalThis.__chatView.kernel.snapshot().timeline;
      return (
        wanted.every((id) => time.layers.some((layer) => layer.id === id)) &&
        (time.status !== 'loading' ||
          wanted.every((id) => !['satellites', 'weather-radar'].includes(id)))
      );
    },
    { timeout: 20_000 },
    ids,
  );
};

const showTime = async (page) => {
  if (!(await shown(page, '#cv-time'))) await page.click(TIME);
  await page.waitForSelector('#cv-time', { visible: true, timeout: 5000 });
};

const scrubTo = async (page, at, { preview = false } = {}) => {
  await page.$eval(
    SCRUB,
    (input, value, onlyPreview) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (!onlyPreview)
        input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    at,
    preview,
  );
  await sleep(200);
};

// The real earthquake investigation owns the clock; the core satellite
// registration only makes desktop's timeline visible so its suppression is
// tested without depending on a remote orbit catalog.
const checkSharedTime = async (page, label) => {
  await prepareLayers(page, ['earthquakes']);
  const result = await page.evaluate(async () => {
    const { worldClock } = await import('/src/time/worldClock.js');
    const end = Date.now() - 3_600_000;
    const release = worldClock.hold('satellites');
    const unregister = worldClock.register({
      id: 'satellites',
      coverage: () => ({ start: end - 3_600_000, end: end + 3_600_000 }),
    });
    const { kernel } = globalThis.__chatView;
    try {
      kernel.act('setTime', {
        mode: 'range',
        fromMs: end - 3_600_000,
        toMs: end,
      });
      await new Promise(requestAnimationFrame);
      const state = worldClock.getState();
      const timeline = document.getElementById('world-timeline');
      const fixed = !state.live && !state.playing && state.timeMs === end;
      const hidden = timeline && getComputedStyle(timeline).display === 'none';
      const lift = getComputedStyle(document.body)
        .getPropertyValue('--world-timeline-lift')
        .trim();
      kernel.act('setTime', { mode: 'live' });
      return {
        fixed,
        hidden: Boolean(hidden),
        lift,
        live: worldClock.isLive(),
      };
    } finally {
      kernel.act('setTime', { mode: 'live' });
      unregister();
      release();
    }
  });
  check(
    `${label}: chat owns shared time and keeps the panels' timeline clear of the composer`,
    result.fixed && result.hidden && result.lift === '0px' && result.live,
    JSON.stringify(result),
  );
};

const checkStop = async (page) => {
  const hold = {
    started: Promise.withResolvers(),
    release: Promise.withResolvers(),
  };
  page.__chatFixtures.weatherHold = hold;
  let deadline;
  try {
    await page.focus('.cv-root textarea');
    await page.keyboard.type('weather at MIA tomorrow');
    await page.tap('.cv-send[aria-label="Send"]');
    await Promise.race([
      hold.started.promise,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Weather request did not start')),
          30_000,
        );
      }),
    ]);
    // The composer intentionally ignores a second tap within 600 ms.
    await sleep(650);
    await page.tap('.cv-send[aria-label="Stop"]');
    await page.waitForFunction(
      () =>
        globalThis.__chatView.kernel.snapshot().session?.turns.at(-1)
          ?.status === 'cancelled',
      { timeout: 10_000 },
    );
    hold.release.resolve();
    const stopped = (await snapshot(page)).session.turns.at(-1).status;
    check(
      'a tap on Stop after a moment stops',
      stopped === 'cancelled',
      stopped,
    );
  } finally {
    clearTimeout(deadline);
    page.__chatFixtures.weatherHold = null;
    hold.release.resolve();
  }
};

const checkTimelineModel = async (page, { scrubOnly = false } = {}) => {
  console.log(
    'Phone: source-aware time, event periods and the shared playhead',
  );
  await prepareLayers(page, ['earthquakes']);
  await page.waitForFunction(
    () => {
      const stats = globalThis.__chatView.components.data.dataManager
        .getAll()
        .find((row) => row.id === 'earthquakes')?.stats;
      return Number.isFinite(stats?.lastUpdate) && stats.count === 3;
    },
    { timeout: 30_000 },
  );
  const week = await ask(page, 'earthquakes in the last 7 days');
  check(
    'a seven-day question waits for all six week-feed events after loading the day feed',
    week?.status === 'done' &&
      week.answer?.count === 6 &&
      week.answer?.events?.length === 6,
    JSON.stringify({
      count: week?.answer?.count,
      events: week?.answer?.events?.length,
    }),
  );
  await showTime(page);
  check(
    'the compact time controls leave the center of the globe open',
    await page.$eval('.cv-time-details', (details) => {
      const stack = details.closest('.cv-bottom');
      return (
        !details.open &&
        stack.getBoundingClientRect().top > innerHeight / 2 &&
        getComputedStyle(stack, '::before').display === 'none'
      );
    }),
  );
  const rolling = await snapshot(page);
  const initialTrack = await (await page.$(SCRUB)).boundingBox();
  const initialY = initialTrack.y + initialTrack.height / 2;
  const firstTouch = await page.touchscreen.touchStart(
    initialTrack.x + initialTrack.width - 8,
    initialY,
  );
  await firstTouch.move(initialTrack.x + initialTrack.width / 2, initialY);
  await firstTouch.end();
  await page.waitForFunction(
    () => !globalThis.__chatView.kernel.snapshot().timeline.live,
    { timeout: 5000 },
  );
  const firstScrub = await snapshot(page);
  check(
    'the first scrub fixes the rolling seven-day period without a notice or opening its editors',
    rolling.session.time.mode === 'recent' &&
      firstScrub.session.time.mode === 'range' &&
      firstScrub.timeline.notice === null &&
      firstScrub.session.time.toMs - firstScrub.session.time.fromMs >=
        7 * 86_400_000 - 1000 &&
      (await page.$eval('.cv-time-details', (details) => {
        const summary = details.querySelector('summary');
        return (
          !details.open &&
          summary.textContent.includes('Event period') &&
          [...summary.querySelectorAll('.cv-time-endpoint > span')]
            .map((label) => label.textContent.trim())
            .join(',') === 'From,To'
        );
      })),
    JSON.stringify({
      time: firstScrub.session.time,
      notice: firstScrub.timeline.notice,
    }),
  );
  await page.focus(SCRUB);
  await page.keyboard.press('End');
  await page.waitForFunction(
    () => globalThis.__chatView.kernel.snapshot().timeline.live,
    { timeout: 5000 },
  );
  await page.tap('.cv-time-details > summary');
  const phone = page.viewport();
  const editorFits = [];
  for (const viewport of [phone, { ...phone, width: 320, height: 568 }]) {
    await page.setViewport(viewport);
    editorFits.push(
      await page.$eval('.cv-time-options', (options) => {
        const box = options.getBoundingClientRect();
        const fields = [
          ...options.querySelectorAll('input[type=datetime-local]'),
        ].map((field) => {
          const rect = field.getBoundingClientRect();
          return {
            top: Math.round((rect.top - box.top) * 100) / 100,
            bottom: Math.round((rect.bottom - box.top) * 100) / 100,
            height: rect.height,
          };
        });
        return {
          height: box.height,
          width: options.clientWidth,
          scrollWidth: options.scrollWidth,
          fields,
          fits:
            fields.length === 2 &&
            options.scrollWidth <= options.clientWidth &&
            fields.every(
              (field) =>
                field.top >= 0 &&
                field.bottom <= box.height &&
                field.height >= 44,
            ),
        };
      }),
    );
  }
  await page.setViewport(phone);
  check(
    'both event-period editors are visible on opening at standard and narrow phone widths',
    editorFits.every((editor) => editor.fits),
    JSON.stringify({ width: phone.width, editorFits }),
  );
  const preset = await page.$('.cv-time-presets button:last-child');
  await preset.tap();
  await page.waitForFunction(
    () =>
      globalThis.__chatView.kernel.snapshot().session?.time.mode === 'range',
    { timeout: 5000 },
  );
  const selected = await snapshot(page);
  const bounds = selected.timeline;
  const filterBefore = await page.evaluate(() =>
    globalThis.__chatView.components.data.dataManager.getLayerParams(
      'earthquakes',
    ),
  );
  const slider = await page.$(SCRUB);
  await slider.scrollIntoView();
  const track = await slider.boundingBox();
  const centerY = track.y + track.height / 2;
  const touch = await page.touchscreen.touchStart(
    track.x + track.width - 8,
    centerY,
  );
  await touch.move(track.x + track.width / 2, centerY);
  const duringTouch = await snapshot(page);
  await touch.end();
  await page.waitForFunction(
    () => !globalThis.__chatView.kernel.snapshot().timeline.live,
    { timeout: 5000 },
  );
  const moved = await snapshot(page);
  const center = (bounds.startMs + bounds.endMs) / 2;
  const pixelTolerance = ((bounds.endMs - bounds.startMs) * 3) / track.width;
  const filterAfter = await page.evaluate(() =>
    globalThis.__chatView.components.data.dataManager.getLayerParams(
      'earthquakes',
    ),
  );
  check(
    'touch drag previews before release and preserves the full seven-day event period',
    duringTouch.timeline.live &&
      Math.abs(moved.timeline.cursorMs - center) < pixelTolerance &&
      Math.abs(
        selected.session.time.toMs -
          selected.session.time.fromMs -
          7 * 86_400_000,
      ) < 1000 &&
      moved.session.time.fromMs === selected.session.time.fromMs &&
      moved.session.time.toMs === selected.session.time.toMs &&
      filterBefore.fromMs === filterAfter.fromMs &&
      filterBefore.toMs === filterAfter.toMs,
    JSON.stringify({ time: moved.session.time, params: filterAfter }),
  );
  check(
    'opening Time keeps the answer cards out of its touch area',
    !(await shown(page, '.cv-float')) && (await shown(page, '#cv-time')),
  );
  if (scrubOnly) {
    await shot(page, 'phone-time-seven-day-period');
    return;
  }
  const preview = await page.evaluate((selector) => {
    const input = document.querySelector(selector);
    const before = globalThis.__chatView.kernel.snapshot();
    input.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 81,
        button: 0,
        isPrimary: true,
        bubbles: true,
      }),
    );
    input.value = String(
      Number(input.min) + (Number(input.max) - Number(input.min)) / 4,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const during = globalThis.__chatView.kernel.snapshot();
    input.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: 81, bubbles: true }),
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      before: before.session.time,
      during: during.session.time,
      after: globalThis.__chatView.kernel.snapshot().session.time,
    };
  }, SCRUB);
  check(
    'a drag previews locally and pointer cancellation changes no shared time',
    JSON.stringify(preview.before) === JSON.stringify(preview.during) &&
      JSON.stringify(preview.before) === JSON.stringify(preview.after),
    JSON.stringify(preview),
  );
  const invalid = await page.evaluate(() => {
    const before = JSON.stringify(
      globalThis.__chatView.kernel.snapshot().session.time,
    );
    const fields = document.querySelectorAll(
      '#cv-time input[type="datetime-local"]',
    );
    const end = Date.parse(fields[1].value);
    const date = new Date(end + 86_400_000);
    const two = (value) => String(value).padStart(2, '0');
    fields[0].value = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
    fields[0].dispatchEvent(new Event('change', { bubbles: true }));
    return (
      before ===
      JSON.stringify(globalThis.__chatView.kernel.snapshot().session.time)
    );
  });
  await sleep(150);
  check(
    'invalid date endpoints are explained and never committed',
    invalid &&
      (await page.$eval('#cv-time [role="status"]', (el) =>
        /start must be before|available data/.test(el.textContent),
      )),
  );
  await page.focus(SCRUB);
  await page.keyboard.press('Home');
  await sleep(150);
  const home = (await snapshot(page)).timeline;
  await page.keyboard.press('End');
  await sleep(150);
  const end = (await snapshot(page)).timeline;
  check(
    'native timeline Home and End reach coverage start and live without changing the event period',
    Math.abs(home.cursorMs - home.startMs) < 1000 &&
      end.live &&
      (await snapshot(page)).session.time.fromMs === moved.session.time.fromMs,
    JSON.stringify({
      home: home.cursorMs,
      start: home.startMs,
      end: end.cursorMs,
      live: end.live,
    }),
  );
  await shot(page, 'phone-time-seven-day-period');

  const editedTo = await page.$eval(
    '#cv-time .cv-time-fields label:last-child input',
    (end) => {
      const at = new Date(Date.parse(end.value) - 86_400_000);
      const two = (value) => String(value).padStart(2, '0');
      end.value = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
      end.dispatchEvent(new Event('change', { bubbles: true }));
      return Date.parse(end.value);
    },
  );
  const afterEdit = await snapshot(page);
  check(
    'editing To accepts a new endpoint after All available without pausing the live cursor',
    afterEdit.session.time.toMs === editedTo &&
      afterEdit.session.time.cursorLive &&
      afterEdit.timeline.live,
    JSON.stringify(afterEdit.session.time),
  );

  const now = Date.now();
  await act(page, 'setTime', {
    mode: 'range',
    fromMs: now - 30 * 86_400_000,
    toMs: now - 29 * 86_400_000,
  });
  await showTime(page);
  const recovered = await snapshot(page);
  const native = await page.$eval(SCRUB, (input) => ({
    min: Number(input.min),
    max: Number(input.max),
    value: Number(input.value),
  }));
  check(
    'an expired period recovers inside coverage with a visible notice and valid native bounds',
    recovered.timeline.notice &&
      recovered.session.time.fromMs <= recovered.session.time.toMs &&
      native.value >= native.min &&
      native.value <= native.max &&
      (await shown(page, '#cv-time [role="status"]')),
    JSON.stringify({ notice: recovered.timeline.notice, native }),
  );
  await shot(page, 'phone-time-expired-recovery');
  await page.click('.cv-golive');
  await sleep(200);
  check(
    'Go live clears the event period and returns the shared world to live',
    (await snapshot(page)).session.time.mode === 'live' &&
      (await page.evaluate(async () =>
        (await import('/src/time/worldClock.js')).worldClock.isLive(),
      )),
  );

  await prepareLayers(page, ['satellites']);
  await showTime(page);
  const satellites = (await snapshot(page)).timeline;
  check(
    'satellite time uses actual core coverage including its forecast',
    satellites.endMs > satellites.nowMs + 13 * 86_400_000 &&
      satellites.startMs < satellites.nowMs - 13 * 86_400_000 &&
      satellites.layers.length === 1 &&
      satellites.layers[0].id === 'satellites',
    JSON.stringify({
      start: satellites.startMs,
      now: satellites.nowMs,
      end: satellites.endMs,
    }),
  );
  await scrubTo(page, satellites.nowMs + 86_400_000);
  check(
    'a future satellite cursor reaches the same shared world clock',
    await page.evaluate(async () => {
      const snap = globalThis.__chatView.kernel.snapshot();
      const { worldClock } = await import('/src/time/worldClock.js');
      return (
        Math.abs(worldClock.now() - snap.timeline.cursorMs) < 1000 &&
        worldClock.now() > Date.now() + 23 * 3_600_000
      );
    }),
  );
  await shot(page, 'phone-time-satellite-forecast');
  const beforePlay = (await snapshot(page)).timeline.cursorMs;
  await page.click('.cv-time-details > summary');
  await page.select('.cv-time-playback select', '3600');
  await page.click('.cv-time-playback button[aria-label="Play"]');
  await page.waitForFunction(
    (before) => {
      const timeline = globalThis.__chatView.kernel.snapshot().timeline;
      return timeline.playing && timeline.cursorMs > before + 60_000;
    },
    { timeout: 5000 },
    beforePlay,
  );
  await page.click('.cv-time-playback button[aria-label="Pause"]');
  const paused = await snapshot(page);
  check(
    'satellite playback runs the shared clock at the chosen rate and persists Pause',
    !paused.timeline.playing &&
      paused.timeline.rate === 3600 &&
      paused.timeline.cursorMs > beforePlay + 60_000 &&
      paused.session.time.cursorMs === paused.timeline.cursorMs,
    JSON.stringify({
      cursor: paused.timeline.cursorMs,
      rate: paused.timeline.rate,
    }),
  );

  await prepareLayers(page, ['weather-radar']);
  await showTime(page);
  const weather = (await snapshot(page)).timeline;
  check(
    'radar time comes from observed source frames rather than a week-wide placeholder',
    weather.endMs - weather.startMs === 2 * 3_600_000 &&
      weather.marks.length === 9 &&
      weather.layers[0].id === 'weather-radar',
    JSON.stringify({
      span: weather.endMs - weather.startMs,
      marks: weather.marks.length,
    }),
  );
  await shot(page, 'phone-time-weather-frames');
  await prepareLayers(page, ['flights']);
  await showTime(page);
  check(
    'a live-only flight investigation offers no historical scrubber',
    (await snapshot(page)).timeline.status === 'live-only' &&
      !(await shown(page, SCRUB)) &&
      (await page.$eval('#cv-time', (el) =>
        /live data only/.test(el.textContent),
      )),
  );
  await shot(page, 'phone-time-live-only');

  await prepareLayers(page, ['earthquakes']);
  const past = await ask(page, 'earthquakes in the last 3 days');
  await ask(page, 'How many flights are over Texas?');
  await act(page, 'restoreTurn', past.id);
  await sleep(250);
  const restored = await snapshot(page);
  check(
    'restoring an earlier answer restores its own time investigation',
    restored.session.time.mode === 'recent' &&
      restored.session.time.hours === 72 &&
      restored.timeline.layers.some((layer) => layer.id === 'earthquakes'),
    JSON.stringify({
      time: restored.session.time,
      layers: restored.timeline.layers.map((layer) => layer.id),
    }),
  );
};

const checkCctvLocation = async () => {
  const page = await open(PHONE);
  const browserContext = page.browserContext();
  const permission = (state) =>
    browserContext.setPermission(new URL(BASE).origin, {
      permission: { name: 'geolocation' },
      state,
    });
  const devicePosition = ({ lat, lon }) =>
    page.setGeolocation({ latitude: lat, longitude: lon, accuracy: 20 });
  const positionMap = () =>
    page.evaluate(
      ({ lat, lon }) =>
        globalThis.__chatView.components.tools.voiceCommands.runner(
          'fly_to_location',
          {
            latitude: lat,
            longitude: lon,
            rangeM: 20_000,
            waitForArrival: true,
          },
        ),
      KANEPI,
    );
  const mapState = () =>
    page.evaluate(() => {
      const { components, kernel } = globalThis.__chatView;
      const viewer = components.scene.viewer;
      const at = viewer.camera.positionCartographic;
      return {
        lat: (at.latitude * 180) / Math.PI,
        lon: (at.longitude * 180) / Math.PI,
        active: kernel.snapshot().stage?.camera?.id ?? null,
      };
    });
  const sameMap = (before, after) =>
    Math.abs(before.lat - after.lat) < 0.01 &&
    Math.abs(before.lon - after.lon) < 0.01;
  const selected = async (id) => {
    await page
      .waitForFunction(
        (cameraId) =>
          globalThis.__chatView.kernel.snapshot().stage?.camera?.id ===
          cameraId,
        { timeout: 4000 },
        id,
      )
      .catch(() => {});
    return (await mapState()).active === id;
  };

  try {
    await permission('denied');
    await devicePosition(MIAMI);
    await fresh(page, '/?ui=chat&lang=en');
    await kernelUp(page);
    const positioned = await positionMap();
    const startingMap = await mapState();
    check(
      'CCTV location fixture starts the globe near Kanepi',
      positioned.ok &&
        Math.abs(startingMap.lat - KANEPI.lat) < 1 &&
        Math.abs(startingMap.lon - KANEPI.lon) < 1,
      JSON.stringify(startingMap),
    );

    const denied = (await ask(page, 'CCTV cameras around me'))?.answer;
    const deniedMap = await mapState();
    check(
      'denied device location gives a location answer without moving or selecting a camera',
      denied?.ok === false &&
        /location|city/i.test(denied.say) &&
        sameMap(startingMap, deniedMap) &&
        deniedMap.active === null,
      JSON.stringify({ say: denied?.say, map: deniedMap }),
    );

    await permission('granted');
    await devicePosition({ lat: 30.4213, lon: -87.2169 });
    const remote = (await ask(page, 'CCTV cameras near me'))?.answer;
    const remoteMap = await mapState();
    check(
      'a device outside the loaded camera radius gets no remote camera',
      remote?.ok === false &&
        /camera/i.test(remote.say) &&
        !/QA (?:Miami|Kanepi) camera/.test(remote.say) &&
        sameMap(startingMap, remoteMap) &&
        remoteMap.active === null,
      JSON.stringify({ say: remote?.say, map: remoteMap }),
    );

    await devicePosition(OFFLINE_MIAMI);
    // Refresh Chrome's last fix after moving the simulated device. The host
    // may reuse a recent fix on real devices.
    const fix = await page.evaluate(
      () =>
        new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(
            ({ coords }) =>
              resolve({ lat: coords.latitude, lon: coords.longitude }),
            ({ message }) => reject(new Error(message)),
            { maximumAge: 0, timeout: 5000 },
          ),
        ),
    );
    const local = (await ask(page, 'CCTV cameras around me'))?.answer;
    check(
      'CCTV near me skips the closest offline camera with the globe near Kanepi',
      fix.lat === OFFLINE_MIAMI.lat &&
        fix.lon === OFFLINE_MIAMI.lon &&
        local?.ok === true &&
        /QA Miami camera/.test(local.say) &&
        /(?:m|km|ft|mi) away/.test(local.say) &&
        (await selected(MIAMI.id)),
      JSON.stringify({ say: local?.say, active: (await mapState()).active }),
    );

    await permission('denied');
    await positionMap();
    const view = (await ask(page, 'CCTV cameras in the view'))?.answer;
    check(
      'CCTV in the view still selects the Kanepi fixture with geolocation denied',
      view?.ok === true &&
        /QA Kanepi camera/.test(view.say) &&
        (await selected(KANEPI.id)),
      view?.say,
    );

    const named = (await ask(page, 'Cameras near MIA'))?.answer;
    check(
      'CCTV near a named place still works with geolocation denied',
      named?.ok === true &&
        /QA Miami camera/.test(named.say) &&
        (await selected(MIAMI.id)),
      named?.say,
    );
    if (await selected(MIAMI.id)) {
      await page.tap('.cv-camera-actions button[aria-label="Next"]');
      await page.waitForFunction(() =>
        document
          .querySelector('.cv-toast')
          ?.textContent.includes('No other working cameras nearby.'),
      );
      check(
        'a single working camera keeps its place when there is no nearby alternative',
        (await mapState()).active === MIAMI.id,
      );
    }
    const county = (await ask(page, 'CCTV in Palm Beach County'))?.answer;
    const first = county?.ok && (await selected(PALM_FIRST.id));
    if (first) await page.tap('.cv-camera-actions button[aria-label="Next"]');
    const next = first && (await selected(PALM_SECOND.id));
    if (next)
      await page.tap('.cv-camera-actions button[aria-label="Previous"]');
    check(
      'Palm Beach County next and previous stay nearby and skip the offline feed',
      first && next && (await selected(PALM_FIRST.id)),
      JSON.stringify({
        say: county?.say,
        first,
        next,
        active: (await mapState()).active,
      }),
    );
  } finally {
    await browserContext.clearPermissionOverrides();
    await page.close();
  }
};

const runFull = async () => {
  console.log('Desktop: the panels first, the chat view from desktop’s chat');
  let page = await open(DESK);
  await fresh(page, '/');
  check(
    'desktop opens in the panels',
    !(await inChatView(page)) && (await shown(page, '#command-dock')),
  );
  await page.keyboard.press('Escape');
  await sleep(400);
  const layersBefore = await page.evaluate(() =>
    localStorage.getItem('gev:layer-state:v2'),
  );
  await page.click('#gev-chat-button');
  await sleep(600);
  check(
    'desktop chat offers the chat view',
    await shown(page, '#gev-chat-view-button'),
  );
  await page.evaluate(async () => {
    const { worldClock } = await import('/src/time/worldClock.js');
    worldClock.pause();
    worldClock.seek(Date.now() - 3_600_000);
  });
  await page.click('#gev-chat-view-button');
  await page.waitForFunction(
    () => globalThis.__chatView?.kernel && document.querySelector('.cv-root'),
    {
      timeout: 30_000,
    },
  );
  await sleep(1200);
  check(
    'opening chat takes time from its session instead of inheriting paused panel time',
    await page.evaluate(async () => {
      const { worldClock } = await import('/src/time/worldClock.js');
      return (
        worldClock.isLive() &&
        (globalThis.__chatView.kernel.snapshot().session?.time?.mode ??
          'live') === 'live'
      );
    }),
  );
  const chrome = await page.evaluate(() =>
    [
      '#title-bar',
      '#command-dock',
      '#left-panel-stack',
      '#right-context-rail',
      '#top-center-actions',
      '#first-run-launcher',
      '#gev-chat-panel',
      '#intel-hud',
    ].filter(
      (selector) =>
        document.querySelector(selector)?.getBoundingClientRect().width > 0,
    ),
  );
  check(
    'the chat view hides the panels’ chrome',
    chrome.length === 0,
    chrome.join(','),
  );
  check(
    'the timeline is tucked away, its button reads Live',
    !(await shown(page, '.cv-time')) &&
      (await timeButton(page)).text === 'Live',
    JSON.stringify(await timeButton(page)),
  );
  await shot(page, 'desk-chat');
  const deskCredits = await page.evaluate(() => {
    const credit = document
      .getElementById('cesium-credits')
      .getBoundingClientRect();
    const shell = document.querySelector('.cv-bottom').getBoundingClientRect();
    return {
      top: Math.round(credit.top),
      bottom: Math.round(credit.bottom),
      shellBottom: Math.round(shell.bottom),
      vh: innerHeight,
    };
  });
  check(
    'desktop credits sit under the composer',
    deskCredits.top >= deskCredits.shellBottom &&
      deskCredits.bottom <= deskCredits.vh,
    JSON.stringify(deskCredits),
  );

  // The Time button opens and closes it; the chip at its end says Live.
  await prepareLayers(page, []);
  await page.click(TIME);
  await sleep(300);
  const afterTap = await shown(page, '.cv-time');
  const liveChip = await page.$eval('.cv-golive', (button) => ({
    on: button.classList.contains('on'),
    disabled: button.disabled,
  }));
  await page.click(TIME);
  await sleep(300);
  check(
    'Time button: empty context shows coverage guidance; a tap tucks and Live glows',
    afterTap &&
      !(await shown(page, '.cv-time')) &&
      liveChip.on &&
      liveChip.disabled,
    JSON.stringify(liveChip),
  );
  // An actual earthquake investigation supplies the available period.
  await prepareLayers(page, ['earthquakes']);
  // Dragging the native track into the past: the button follows and closes.
  await page.click(TIME);
  await sleep(300);
  const track = await page.$eval(SCRUB, (el) => {
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y + box.height / 2, w: box.width };
  });
  await page.mouse.move(track.x + track.w * 0.99, track.y);
  await page.mouse.down();
  await page.mouse.move(track.x + track.w * 0.6, track.y, { steps: 6 });
  await page.mouse.up();
  await sleep(500);
  const dragged = await timeButton(page);
  const chipPast = await page.$eval('.cv-golive', (button) => ({
    on: button.classList.contains('on'),
    name: button.getAttribute('aria-label'),
  }));
  await page.click(TIME);
  await sleep(300);
  const closedPast =
    !(await shown(page, '.cv-time')) &&
    (await snapshot(page)).session.time.mode === 'range';
  check(
    'a drag back moves the button off Live, and it still closes in the past',
    dragged.text !== 'Live' &&
      /^Timeline: /.test(dragged.name) &&
      !chipPast.on &&
      chipPast.name === 'Go live' &&
      closedPast,
    `${JSON.stringify(dragged)} ${JSON.stringify(chipPast)}`,
  );
  await page.click(TIME);
  await sleep(300);
  await page.click('.cv-golive');
  await sleep(500);
  check(
    'the Live chip goes live and tucks the timeline away',
    !(await shown(page, '.cv-time')) &&
      (await timeButton(page)).text === 'Live',
  );
  await checkSharedTime(page, 'desktop');
  const framing = await page.evaluate(async () => {
    const { createAgentRunner } = await import('/src/chatView/agentRunner.js');
    const { components, kernel } = globalThis.__chatView;
    const run = createAgentRunner({
      steps: components.tools.voiceCommands.runner,
      resolvePlace: async () => null,
      time: () => kernel.snapshot().session.time,
    });
    const result = await run('fly_to_location', {
      latitude: 13.5362,
      longitude: -90.8798,
      viewMode: 'overview',
      waitForArrival: true,
    });
    return {
      ok: result.ok,
      rangeM: result.rangeM,
      heightM: components.scene.viewer.camera.positionCartographic.height,
    };
  });
  check(
    'an unsized coordinate result frames the surrounding region',
    framing.ok && framing.rangeM === 400_000 && framing.heightM > 100_000,
    JSON.stringify(framing),
  );

  // A question that moves time pulls the timeline out; Go live tucks it.
  await ask(page, 'earthquakes from the last 3 days');
  await sleep(800);
  const past = (await snapshot(page)).session.time;
  check(
    'a time question pulls the timeline out',
    (await shown(page, '.cv-time')) && past?.mode !== 'live',
    JSON.stringify(past),
  );
  await shot(page, 'desk-chat-quakes');
  const feed = await page.evaluate(
    () =>
      globalThis.__chatView.components.data.dataManager.getLayerParams(
        'earthquakes',
      )?.feed ?? 'day',
  );
  await page.click('.cv-golive').catch(() => {});
  await sleep(600);
  check(
    'Go live tucks the timeline away',
    !(await shown(page, '.cv-time')) &&
      (await timeButton(page)).text === 'Live',
  );

  // A weather answer names its provider beside its numbers.
  const weather = await ask(page, 'What was the weather at MIA yesterday?');
  await sleep(500);
  const credit = await page.evaluate(() => {
    const link = document.querySelector('.cv-float .cv-sources a');
    return link
      ? {
          text: link.textContent.trim(),
          href: link.href,
          opacity: getComputedStyle(link).opacity,
        }
      : null;
  });
  check(
    'a weather answer credits Open-Meteo, linked and full strength',
    weather?.answer?.ok !== false &&
      /Open-Meteo/.test(credit?.text || '') &&
      /open-meteo\.com/.test(credit?.href || '') &&
      credit.opacity === '1',
    JSON.stringify(credit),
  );
  await shot(page, 'desk-chat-weather');
  await ask(page, 'earthquakes from the last 3 days');
  await sleep(500);

  // Back to the panels: the same globe, live time, saved layers untouched.
  const enabledNow = () =>
    page.evaluate(() => {
      const manager =
        globalThis.__godsEyeView?.dataManager ??
        globalThis.__chatView?.components.data.dataManager;
      return manager
        .getAll()
        .filter((layer) => manager.isEffectivelyEnabled(layer.id))
        .map((layer) => layer.id);
    });
  const onInChat = await enabledNow();
  await page.click('.cv-to-panels');
  await sleep(1500);
  const back = await page.evaluate(() => ({
    mode: document.body.classList.contains('chat-view-mode'),
    shell: Boolean(document.getElementById('cv-app')),
    dock: Boolean(
      document.querySelector('#command-dock')?.getBoundingClientRect().width,
    ),
  }));
  const onInPanels = await enabledNow();
  const feedAfter = await page.evaluate(
    () =>
      globalThis.__godsEyeView.dataManager.getLayerParams('earthquakes')
        ?.feed ?? 'day',
  );
  check(
    'switching back shows the panels and drops the shell',
    !back.mode && !back.shell && back.dock,
    JSON.stringify(back),
  );
  check(
    'the globe keeps the chat view’s layers',
    JSON.stringify(onInChat) === JSON.stringify(onInPanels),
    `${onInChat} → ${onInPanels}`,
  );
  check(
    'time is live again for the panels',
    feed === 'week' && feedAfter === 'day',
    `feed ${feed} → ${feedAfter}`,
  );
  check(
    'the chat view never saved the panels’ layers',
    layersBefore ===
      (await page.evaluate(() => localStorage.getItem('gev:layer-state:v2'))),
  );
  await boot(page, '/');
  check('a reload stays in the panels', !(await inChatView(page)));
  await page.close();

  console.log('Phone: stock Panels first, Chat by request');
  page = await open(PHONE);
  await fresh(page, '/');
  check(
    'a first phone visit opens stock Panels',
    await shown(page, '#mobile-tab-bar'),
  );
  await boot(page, '/?ui=chat');
  await kernelUp(page);
  await sleep(800);
  check(
    'a phone can opt into the chat view',
    (await inChatView(page)) &&
      (await page.evaluate(() => Boolean(globalThis.__chatView?.kernel))),
  );
  check(
    'no tab bar or first-run card over it',
    !(await shown(page, '#mobile-tab-bar')) &&
      !(await shown(page, '#first-run-launcher')),
  );
  await shot(page, 'phone-chat');
  await ask(page, 'How many flights are over Texas?');
  await sleep(1500);
  await shot(page, 'phone-answer');
  const overlap = await page.evaluate(() => {
    const pill = document.querySelector('.cv-pill')?.getBoundingClientRect();
    const panels = document
      .querySelector('.cv-to-panels')
      ?.getBoundingClientRect();
    return pill && panels ? pill.right > panels.left - 4 : null;
  });
  check(
    'the pill stays clear of the panels button',
    overlap === false,
    String(overlap),
  );
  const credits = await page.evaluate(() => {
    const credit = document.getElementById('cesium-credits');
    const box = credit.getBoundingClientRect();
    const shell = document.querySelector('.cv-bottom').getBoundingClientRect();
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      left: Math.round(box.left),
      right: Math.round(box.right),
      shellBottom: Math.round(shell.bottom),
      opacity: getComputedStyle(credit).opacity,
      vw: innerWidth,
      vh: innerHeight,
    };
  });
  check(
    'credits: one full-strength line under the shell, on screen',
    credits.top >= credits.shellBottom &&
      credits.bottom <= credits.vh &&
      credits.left >= 0 &&
      credits.right <= credits.vw &&
      credits.opacity === '1',
    JSON.stringify(credits),
  );

  // Watch with nothing asked: no false "Watching" toast.
  await act(page, 'newSession');
  await sleep(800);
  await page.evaluate(() =>
    [...document.querySelectorAll('.cv-tool')]
      .find((button) => /Watch/.test(button.getAttribute('aria-label') || ''))
      ?.click(),
  );
  await sleep(300);
  const toast = await page.evaluate(
    () => document.querySelector('.cv-toast')?.textContent?.trim() || '',
  );
  check(
    'Watch before asking says to ask first',
    /Ask a question first/.test(toast),
    toast,
  );
  // A double tap on send keeps the question.
  const ime = await page.evaluate(() => {
    const input = document.querySelector('.cv-root textarea');
    const before =
      globalThis.__chatView.kernel.snapshot().session?.turns.length ?? 0;
    input.value = '東京';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      }),
    );
    const safari = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    });
    Object.defineProperty(safari, 'keyCode', { value: 229 });
    input.dispatchEvent(safari);
    const after =
      globalThis.__chatView.kernel.snapshot().session?.turns.length ?? 0;
    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    );
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after };
  });
  check(
    'IME confirmation Enter and Safari keyCode229 keep the draft unsent',
    ime.before === ime.after,
    JSON.stringify(ime),
  );
  await page.click('.cv-root textarea');
  await page.keyboard.type('Any emergencies?');
  await page.keyboard.press('Enter');
  await sleep(15);
  await page.keyboard.press('Enter');
  await page.evaluate(() => document.querySelector('.cv-send')?.click());
  await page
    .waitForFunction(
      () => {
        const turn = globalThis.__chatView.kernel
          .snapshot()
          .session?.turns.at(-1);
        return turn && turn.status !== 'running';
      },
      { timeout: 60_000 },
    )
    .catch(() => {});
  const doubled = (await snapshot(page)).session.turns.map(
    (turn) => turn.status,
  );
  check(
    'a double send keeps the question',
    doubled.at(-1) === 'done' && doubled.length === 1,
    JSON.stringify(doubled),
  );
  await checkStop(page);

  // The drawer is a dialog: focus moves in, one Esc closes it, focus returns.
  await page.focus('.cv-pill');
  await page.keyboard.press('Enter');
  await sleep(450);
  const inside = await page.evaluate(() =>
    Boolean(document.activeElement?.closest('.cv-panel')),
  );
  const dialog = await page.evaluate(() =>
    document.querySelector('.cv-drawer')?.getAttribute('role'),
  );
  await page.evaluate(() => {
    globalThis.__qaAnimations = 0;
    const panel = document.querySelector('.cv-panel');
    const animate = panel.animate.bind(panel);
    panel.animate = (...args) => {
      globalThis.__qaAnimations += 1;
      return animate(...args);
    };
  });
  await page.keyboard.press('Escape');
  await sleep(500);
  check(
    'the drawer is a dialog and takes focus',
    dialog === 'dialog' && inside,
  );
  check(
    'one Esc runs one close',
    (await page.evaluate(() => globalThis.__qaAnimations)) === 1,
  );
  check(
    'focus returns to the pill',
    await page.evaluate(() =>
      document.activeElement?.classList.contains('cv-pill'),
    ),
  );
  // The + menu's tabs are real tabs.
  await page.click('.cv-tool.plus');
  await sleep(300);
  const tabs = await page.evaluate(() => ({
    selected: [...document.querySelectorAll('.cv-menu-tabs [role="tab"]')].map(
      (tab) => tab.getAttribute('aria-selected'),
    ),
    panel: document.querySelector('.cv-root [role="tabpanel"]')?.id,
  }));
  await page.focus('.cv-menu-tabs [role="tab"]');
  await page.keyboard.press('ArrowRight');
  await sleep(200);
  const moved = await page.evaluate(() =>
    [...document.querySelectorAll('.cv-menu-tabs [role="tab"]')]
      .map((tab) => tab.getAttribute('aria-selected'))
      .join(','),
  );
  check(
    'the + menu’s tabs use aria-selected and arrows',
    tabs.selected.join(',') === 'true,false,false,false' &&
      tabs.panel &&
      moved === 'false,true,false,false',
    `${JSON.stringify(tabs)} → ${moved}`,
  );
  await page.keyboard.press('Escape');
  // A layer's own controls: Active Fires' FRP slider, dragged in the Layers
  // tab, filters the layer as desktop's row does, at 375 and at 320, inside
  // the menu, and the chat view saves none of it as the panels' choice.
  const FIRES = '.cv-root .cv-controls[data-layer-id="local-firms"]';
  const savedLayers = () =>
    page.evaluate(() => localStorage.getItem('gev:layer-state:v2'));
  const firesFilter = () =>
    page.evaluate(() =>
      globalThis.__chatView.components.data.dataManager.getLayerParams(
        'local-firms',
      ),
    );
  const savedBeforeControls = await savedLayers();
  const firesWasOn = await page.evaluate(() =>
    globalThis.__chatView.components.data.dataManager.isEnabled('local-firms'),
  );
  if (!firesWasOn) await act(page, 'toggleLayer', 'local-firms');
  await page.click('.cv-tool.plus');
  await sleep(300);
  await page.evaluate(() =>
    [...document.querySelectorAll('.cv-menu-tabs [role="tab"]')][1].click(),
  );
  await page
    .waitForSelector(`${FIRES} .cv-range`, { timeout: 15_000 })
    .catch(() => {});
  const drags = [];
  for (const [width, at] of [
    [375, 0.7],
    [320, 0.35],
  ]) {
    await page.setViewport({ ...PHONE, width });
    await sleep(300);
    const range = await page.evaluate((controls) => {
      const block = document.querySelector(controls);
      if (!block) return null;
      block.scrollIntoView({ block: 'center' });
      const input = block.querySelector('.cv-range');
      const box = input.getBoundingClientRect();
      // The thumb's center; it is 22px wide.
      const share = (input.value - input.min) / (input.max - input.min);
      return {
        x: box.x,
        y: box.y + box.height / 2,
        w: box.width,
        thumb: box.x + 11 + (box.width - 22) * share,
      };
    }, FIRES);
    if (!range) break;
    await page.mouse.move(range.thumb, range.y);
    await page.mouse.down();
    await page.mouse.move(range.x + range.w * at, range.y, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    drags.push(
      await page.evaluate(
        (controls, filter) => {
          const block = document.querySelector(controls);
          const menu = document
            .querySelector('.cv-menu')
            .getBoundingClientRect();
          const outside = [...block.querySelectorAll('*')].filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              (r.left < menu.left - 0.5 || r.right > menu.right + 0.5)
            );
          });
          return {
            width: innerWidth,
            minFrp: filter?.minFrp,
            shown: block.querySelector('output')?.textContent.trim(),
            outside: outside.length,
            sideways: document.documentElement.scrollWidth > innerWidth,
          };
        },
        FIRES,
        await firesFilter(),
      ),
    );
  }
  await page.evaluate((controls) => {
    [...document.querySelectorAll(`${controls} [role="radio"]`)]
      .at(-1)
      ?.click();
  }, FIRES);
  await sleep(300);
  const confidence = (await firesFilter())?.confidence;
  const [wide, narrow] = drags;
  check(
    'a layer’s own controls work in the Layers tab at 375 and 320 px',
    drags.length === 2 &&
      wide.minFrp > narrow.minFrp &&
      narrow.minFrp > 0 &&
      drags.every(
        (drag) => /\d/.test(drag.shown) && !drag.outside && !drag.sideways,
      ) &&
      confidence === 'high' &&
      (await savedLayers()) === savedBeforeControls,
    `${JSON.stringify(drags)} confidence ${confidence}`,
  );
  await shot(page, 'phone-320-layer-controls');
  await page.keyboard.press('Escape');
  if (!firesWasOn) await act(page, 'toggleLayer', 'local-firms');
  // 320 wide: the timeline's label stays on one line, nothing scrolls sideways.
  await page.setViewport({ ...PHONE, width: 320, height: 568 });
  await checkSharedTime(page, '320 px phone');
  await ask(page, 'earthquakes in the last 24 hours');
  await sleep(800);
  const label = await page.evaluate(() => {
    const at = document.querySelector('.cv-time-readout');
    return at
      ? {
          h: Math.round(at.getBoundingClientRect().height),
          text: at.textContent,
          overflow: document.documentElement.scrollWidth > innerWidth,
        }
      : null;
  });
  check(
    'the timeline’s label is one line at 320, with no sideways scroll',
    label && label.h <= 20 && !label.overflow,
    JSON.stringify(label),
  );
  await shot(page, 'phone-320');
  // Every control in the composer's row stays inside it, at the narrowest
  // phones and at the widths where the short time label takes over.
  const clipped = [];
  for (const width of [320, 360, 389, 390]) {
    await page.setViewport({ ...PHONE, width });
    await sleep(200);
    const outside = await page.evaluate(() => {
      const box = document
        .querySelector('.cv-composer')
        .getBoundingClientRect();
      return [...document.querySelectorAll('.cv-tools > *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            (r.left < box.left - 0.5 || r.right > box.right + 0.5)
          );
        })
        .map((el) => el.getAttribute('aria-label') || el.className);
    });
    if (outside.length) clipped.push(`${width}: ${outside.join(', ')}`);
  }
  check(
    'the composer’s row keeps every control inside it from 320 to 390 px',
    clipped.length === 0,
    clipped.join(' | '),
  );
  await page.setViewport(PHONE);
  await checkTimelineModel(page);
  await page.click('.cv-tool.plus');
  await page.click('[role="tab"][aria-controls="cv-menu-panel"]:nth-child(2)');
  await page.click('[data-library-launcher]');
  await page.waitForSelector('#data-library[open]', { visible: true });
  await page.waitForSelector(
    '#data-library .data-library-item-details > summary',
  );
  const compact = await page.evaluate(() => {
    const dialog = document.querySelector('#data-library');
    const details = dialog.querySelector('.data-library-item-details');
    const overview = dialog.querySelector('.data-library-overview');
    const collapsed = !details.open && !overview.open;
    details.querySelector('summary').click();
    return (
      collapsed &&
      details.open &&
      !!details.querySelector('.data-library-meta a') &&
      dialog.scrollWidth <= dialog.clientWidth + 1
    );
  });
  check(
    'Chat Library keeps catalogue details available on demand without sideways scroll',
    compact,
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('#data-library[open]'),
  );
  check(
    'Chat Layers opens the stock Data Library and restores launcher focus',
    await page.evaluate(() =>
      document.activeElement?.hasAttribute('data-library-launcher'),
    ),
  );
  await page.click('.cv-to-panels');
  await sleep(1500);
  check(
    'a phone switches to the stock tab bar',
    await shown(page, '#mobile-tab-bar'),
  );
  const sheets = {
    layers: '#data-panel #data-library-browse',
    cameras: '#street-level-panel',
    context: '#global-context-panel',
    search: '#location-bar',
    more: '#control-panel',
  };
  for (const [sheet, selector] of Object.entries(sheets)) {
    await page.click(`#mobile-tab-bar [data-mobile-sheet="${sheet}"]`);
    await page.waitForSelector(selector, { visible: true });
    check(
      `the stock ${sheet} sheet still opens after Chat`,
      await shown(page, selector),
    );
  }
  await page.close();

  console.log('Addresses and languages');
  page = await open(PHONE);
  await boot(page, '/?ui=panels');
  check(
    '?ui=panels opens the panels on a phone, and the address drops it',
    (await shown(page, '#mobile-tab-bar')) &&
      !(await page.evaluate(() => location.search.includes('ui='))),
    await page.evaluate(() => location.href),
  );
  await page.close();
  page = await open(DESK);
  await boot(page, '/mob');
  await kernelUp(page);
  check(
    '/mob opens the chat view at /',
    (await inChatView(page)) &&
      (await page.evaluate(() => location.pathname === '/')),
    await page.evaluate(() => location.href),
  );
  await page.close();
  page = await open(PHONE);
  await page.goto(`${BASE}/?ui=chat&lang=ar`, {
    waitUntil: 'domcontentloaded',
  });
  const loader = await page.evaluate(
    () => document.querySelector('#loading-screen .loader-status')?.textContent,
  );
  await kernelUp(page);
  const dir = await page.evaluate(() => document.documentElement.dir);
  check(
    'Arabic reads right to left, and the loader is translated',
    dir === 'rtl' && !/Starting the globe/.test(loader || ''),
    `${dir} “${loader}”`,
  );
  await sleep(2000);
  await shot(page, 'phone-ar');
  await page.close();
};

try {
  console.log(
    'Evidence: owned USGS/weather/flight/TLE network fixtures; real source adapters, shared world clock and chat UI. Model routes deliberately unavailable for deterministic planner coverage.',
  );
  if (cctvOnly) {
    await checkCctvLocation();
  } else if (focused) {
    const page = await open({ ...PHONE, width: 393, height: 664 });
    await fresh(page, '/?ui=chat&lang=en');
    await kernelUp(page);
    await checkStop(page);
    await checkTimelineModel(page, { scrubOnly: true });
  } else {
    await runFull();
    await checkCctvLocation();
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  const diagnostic =
    activePage && !activePage.isClosed()
      ? {
          pending: [...activePage.__qaPending.values()].slice(0, 30),
          state: await activePage
            .evaluate(() => ({
              ready: document.readyState,
              loader: document.querySelector('.loader-status')?.textContent,
              core: Boolean(globalThis.__godsEyeView),
              chat: Boolean(globalThis.__chatView),
            }))
            .catch((failure) => failure.message),
        }
      : null;
  console.error('Browser diagnostic:', JSON.stringify(diagnostic));
  check(
    'the complete browser suite finishes',
    false,
    error.stack || error.message,
  );
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(shotsDir, 'report.json'),
    JSON.stringify(
      {
        evidence:
          'Owned feed boundary fixtures; actual layer adapters, shared clock, kernel and UI. Not live-provider proof.',
        baseUrl: BASE,
        scope: cctvOnly
          ? 'focused CCTV location'
          : focused
            ? 'focused timeline'
            : 'full chat view',
        checks,
        errors,
        failures,
      },
      null,
      2,
    ),
  );
}

if (failures.length) {
  console.error(`\nChat view QA failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nChat view QA passed. Screenshots: ${shotsDir}`);
}
