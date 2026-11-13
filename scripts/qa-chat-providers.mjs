#!/usr/bin/env node
/**
 * Hermetic browser proof for the map chat's shared provider interface.
 * Run against a dev server with QA_BASE_URL=http://localhost:4173.
 * HTTP, OAuth WebSocket and feed replies are fixtures, not live provider tests.
 * The real selector, kernel, provider facade, transports and actions still run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.QA_BASE_URL || 'http://localhost:4173';
const origin = new URL(base).origin;
const shots =
  process.env.QA_SHOTS_DIR || path.join(root, 'qa-shots', 'chat-providers');
fs.mkdirSync(shots, { recursive: true });
const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath());
const browser = await puppeteer.launch({
  executablePath,
  headless: !process.argv.includes('--headful'),
  protocolTimeout: 90_000,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const failures = [];
const check = (name, okay) => {
  console.log(`[${okay ? 'PASS' : 'FAIL'}] ${name}`);
  if (!okay) failures.push(name);
};
const page = await browser.newPage();
page.setDefaultTimeout(15_000);
await page.setViewport({
  width: 375,
  height: 812,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const pageErrors = [];
page.on('pageerror', (error) =>
  pageErrors.push(error.message.replace(/https?:\/\/\S+/g, '[url]')),
);
const requests = [];
const tokens = [];
let unavailable = false;
let hold = false;
let held = null;

const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const weather = {
  today,
  timezone: 'America/New_York',
  days: [
    {
      date: yesterday,
      weatherCode: 63,
      highC: 28,
      lowC: 22,
      precipitationMm: 12,
    },
    { date: today, weatherCode: 1, highC: 29, lowC: 23, precipitationMm: 0 },
  ],
};
const toolsFor = (provider) => [
  {
    name: 'set_layer_visibility',
    args: { layerId: 'earthquakes', enabled: true },
  },
  {
    name: 'get_weather_by_day',
    args: { latitude: 25.76, longitude: -80.19, from_day: -1, to_day: -1 },
  },
  {
    name: 'set_timeline',
    args: { hours_back: provider === 'gemini' ? 6 : 24 },
  },
];
const firstReply = (provider) =>
  provider === 'gemini'
    ? {
        content: {
          role: 'model',
          parts: toolsFor(provider).map((call) => ({ functionCall: call })),
        },
      }
    : {
        content: {
          role: 'assistant',
          content: null,
          tool_calls: toolsFor(provider).map(({ name, args }, index) => ({
            id: `map-${index}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          })),
        },
      };
const finalReply = (provider) =>
  provider === 'gemini'
    ? {
        content: {
          role: 'model',
          parts: [{ text: 'Gemini fixture weather and time are on screen.' }],
        },
        finishReason: 'STOP',
      }
    : {
        content: {
          role: 'assistant',
          content: 'OpenAI fixture weather and time are on screen.',
        },
        finishReason: 'stop',
      };
const continued = (provider, body) => {
  if (provider === 'openai') {
    const last = body.messages.findLastIndex(
      (message) => message.role === 'user',
    );
    return body.messages
      .slice(last + 1)
      .some((message) => message.role === 'tool');
  }
  const last = body.contents.findLastIndex(
    (message) =>
      message.role === 'user' &&
      message.parts.some((part) => typeof part.text === 'string'),
  );
  return body.contents
    .slice(last + 1)
    .some((message) => message.parts.some((part) => part.functionResponse));
};
const respond = (request, body, status = 200) =>
  request.respond({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });

await page.setRequestInterception(true);
page.on('request', async (request) => {
  try {
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      /^\/api\/(openai|gemini)\/chat$/.test(url.pathname)
    ) {
      const provider = url.pathname.split('/')[2];
      const body = JSON.parse(request.postData());
      requests.push({ provider, body });
      if (hold && provider === 'openai') {
        held = request;
        return;
      }
      if (unavailable)
        return await respond(request, { code: 'API_KEY_MISSING' }, 503);
      return await respond(
        request,
        continued(provider, body) ? finalReply(provider) : firstReply(provider),
      );
    }
    if (url.origin === origin && url.pathname === '/api/realtime/token') {
      tokens.push({ auth: url.searchParams.get('auth') });
      return await respond(request, {
        value: 'ephemeral-browser-fixture',
        session: {
          model: 'fixture-model',
          tools: [
            {
              type: 'function',
              name: 'set_layer_visibility',
              parameters: { type: 'object' },
            },
          ],
        },
      });
    }
    if (url.origin === origin && url.pathname === '/api/weather-daily')
      return await respond(request, weather);
    if (url.hostname === 'earthquake.usgs.gov')
      return await respond(request, {
        type: 'FeatureCollection',
        metadata: { generated: Date.now() },
        features: [
          {
            type: 'Feature',
            id: 'provider-fixture-quake',
            properties: {
              mag: 5.2,
              place: 'Provider browser fixture',
              time: Date.now() - 3_600_000,
            },
            geometry: { type: 'Point', coordinates: [-80.19, 25.76, 12] },
          },
        ],
      });
    if (url.origin === origin && url.pathname.startsWith('/api/'))
      return await respond(request, {});
    if (url.origin !== origin && ['http:', 'https:'].includes(url.protocol))
      return await request.abort();
    await request.continue();
  } catch {
    // A cancelled request can finish its interception after its owner left.
    if (!request.isInterceptResolutionHandled())
      await request.abort().catch(() => {});
  }
});

await page.evaluateOnNewDocument(() => {
  localStorage.setItem('gev.voice.provider', 'openai');
  localStorage.setItem('godsEyeView.voice.cloudAuth', 'api-key');
  localStorage.setItem('gev:ui-mode:v1', 'chat');
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.__providerSocketFixture = { events: [] };
  // Replace only the browser network boundary, never a core transport function.
  globalThis.WebSocket = class FixtureWebSocket {
    constructor(url, protocols) {
      if (!String(url).startsWith('wss://api.openai.com/v1/realtime'))
        return new NativeWebSocket(url, protocols);
      this.readyState = 0;
      this.round = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(raw) {
      const event = JSON.parse(raw);
      globalThis.__providerSocketFixture.events.push(event);
      const emit = (value) => this.onmessage?.({ data: JSON.stringify(value) });
      if (event.type === 'conversation.item.create')
        queueMicrotask(() =>
          emit({
            type: 'conversation.item.added',
            item: {
              id: `item-${globalThis.__providerSocketFixture.events.length}`,
            },
          }),
        );
      if (event.type !== 'response.create') return;
      const id = `response-${++this.round}`;
      const output =
        this.round === 1
          ? [
              {
                type: 'function_call',
                call_id: 'weather-call',
                name: 'get_weather_by_day',
                arguments: JSON.stringify({
                  latitude: 25.76,
                  longitude: -80.19,
                  from_day: -1,
                  to_day: -1,
                }),
              },
            ]
          : [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'OAuth fixture weather is on screen.',
                  },
                ],
              },
            ];
      queueMicrotask(() => {
        emit({ type: 'response.created', response: { id } });
        emit({
          type: 'response.done',
          response: { id, status: 'completed', output },
        });
      });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  };
});

const snapshot = () =>
  page.evaluate(() => globalThis.__chatView.kernel.snapshot());
const screenshot = (name) =>
  page.screenshot({ path: path.join(shots, `${name}.png`) });
const menu = async () => {
  if (!(await page.$('.cv-provider-select'))) await page.click('.cv-tool.plus');
  await page.waitForSelector('.cv-menu');
  const add = await page.$('.cv-menu-tabs [role="tab"]');
  if (
    add &&
    (await add.evaluate(
      (element) => element.getAttribute('aria-selected') !== 'true',
    ))
  )
    await add.click();
  await page.waitForSelector('select.cv-provider-select');
};
const selectProvider = async (value) => {
  await menu();
  await page.select('select.cv-provider-select', value);
  await page.waitForFunction(
    (id) => globalThis.__chatView.kernel.snapshot().provider?.id === id,
    {},
    value,
  );
};
const selectAuth = async (value) => {
  await menu();
  await page.select('select.cv-auth-select', value);
  await page.waitForFunction(
    (mode) =>
      globalThis.__chatView.kernel.snapshot().provider?.authMode === mode,
    {},
    value,
  );
};
const closeMenu = async () => {
  if (await page.$('.cv-menu')) await page.keyboard.press('Escape');
};
const send = async (text) => {
  await closeMenu();
  const count = (await snapshot()).session?.turns.length || 0;
  await page.click('.cv-composer textarea');
  await page.type('.cv-composer textarea', text);
  await page.click('.cv-send');
  await page.waitForFunction(
    (before) =>
      (globalThis.__chatView.kernel.snapshot().session?.turns.length || 0) >
      before,
    {},
    count,
  );
};
const complete = async () => {
  await page.waitForFunction(
    () =>
      globalThis.__chatView.kernel.snapshot().session?.turns.at(-1)?.status !==
      'running',
    { timeout: 30_000 },
  );
  return (await snapshot()).session.turns.at(-1);
};

try {
  console.log(
    'Fixture-backed mobile provider proof; no live model or feed results are claimed.',
  );
  await page.goto(`${base}/?ui=chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      globalThis.__chatView?.kernel &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60_000 },
  );
  await menu();
  check(
    'mobile Add exposes the shared OpenAI and Gemini selection',
    await page.$eval('select.cv-provider-select', (element) =>
      ['openai', 'gemini'].every((id) =>
        [...element.options].some((option) => option.value === id),
      ),
    ),
  );
  await selectProvider('openai');
  await selectAuth('api-key');
  await send('OpenAI fixture weather and earthquakes');
  let turn = await complete();
  let view = await snapshot();
  check(
    'OpenAI API-key chat executes weather and timeline capabilities',
    /OpenAI fixture/.test(turn.answer.say) &&
      view.session.time.mode !== 'live' &&
      turn.answer.sources.some((source) => /Open-Meteo/.test(source.label)),
  );
  check(
    'the actual earthquake layer was enabled by the tool action',
    await page.evaluate(() =>
      globalThis.__chatView.components.data.dataManager.isEnabled(
        'earthquakes',
      ),
    ),
  );
  await screenshot('openai-api-mobile');

  await selectProvider('gemini');
  await send('Gemini fixture weather and earthquakes');
  turn = await complete();
  view = await snapshot();
  check(
    'Gemini uses the same map capabilities and keeps prior investigation context',
    /Gemini fixture/.test(turn.answer.say) &&
      view.session.time.mode !== 'live' &&
      JSON.stringify(
        requests.find(({ provider }) => provider === 'gemini')?.body,
      ).includes('OpenAI fixture weather and earthquakes'),
  );
  check(
    'every HTTP continuation requests the canonical map-chat tool profile',
    requests.length >= 4 &&
      requests.every(({ body }) => body.toolProfile === 'map-chat'),
  );
  await screenshot('gemini-mobile');

  await selectProvider('openai');
  hold = true;
  await send('Hold provider request');
  await page.waitForFunction(
    () => globalThis.__chatView.kernel.snapshot().busy,
  );
  const deadline = Date.now() + 10_000;
  while (!held && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (!held)
    throw new Error('The cancellation fixture did not receive its request');
  await selectProvider('gemini');
  await complete();
  hold = false;
  await respond(held, firstReply('openai')).catch(() => {});
  await send('Gemini fixture after switching');
  turn = await complete();
  const latestGemini = requests
    .filter(({ provider }) => provider === 'gemini')
    .at(-1);
  view = await snapshot();
  check(
    'provider switching cancels the retired reply and preserves completed history',
    view.session.turns.some(
      (item) =>
        item.q === 'Hold provider request' && item.status === 'cancelled',
    ) &&
      /Gemini fixture/.test(turn.answer.say) &&
      !JSON.stringify(latestGemini.body).includes('Hold provider request'),
  );

  await selectProvider('openai');
  await selectAuth('oauth');
  const httpBeforeOAuth = requests.length;
  await send('OAuth fixture weather');
  turn = await complete();
  const socket = await page.evaluate(
    () => globalThis.__providerSocketFixture.events,
  );
  check(
    'explicit ChatGPT sign-in uses the shared OAuth backend instead of the API-key HTTP path',
    /OAuth fixture/.test(turn.answer.say) &&
      tokens.some(({ auth }) => auth === 'oauth') &&
      requests.length === httpBeforeOAuth,
  );
  check(
    'OAuth offers the same canonical map tools and retains saved session context',
    socket.some(
      (event) =>
        event.type === 'session.update' &&
        event.session.tools.some(
          (tool) => tool.name === 'get_weather_by_day',
        ) &&
        event.session.tools.some((tool) => tool.name === 'set_timeline'),
    ) && JSON.stringify(socket).includes('Gemini fixture after switching'),
  );
  await screenshot('oauth-mobile');

  await selectAuth('api-key');
  unavailable = true;
  await send('earthquakes in the last 24 hours');
  turn = await complete();
  await menu();
  view = await snapshot();
  check(
    'an unavailable selected provider is shown while the planner answers honestly',
    view.provider.id === 'openai' &&
      view.provider.status === 'unavailable' &&
      /OPENAI_API_KEY/.test(
        await page.$eval(
          '.cv-provider-status',
          (element) => element.textContent,
        ),
      ) &&
      Boolean(turn.title) &&
      turn.answer.ok !== false,
  );
  await screenshot('unavailable-planner-mobile');
  check('no uncaught browser errors', pageErrors.length === 0);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
} finally {
  await browser.close();
}
if (failures.length)
  throw new Error(`Provider browser proof failed: ${failures.join(', ')}`);
console.log(`Provider browser proof passed. Screenshots: ${shots}`);
