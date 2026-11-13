import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderTextAgent, createHttpTextAgent } from './textAgent.js';
import { MAP_CHAT_TOOLS } from './mapChatTools.js';
import { CLOUD_VOICE_AUTH_STORAGE_KEY } from './cloudVoiceAuth.js';
import { fakeRealtime, call, say } from '../testSupport/fakeRealtime.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function selected(initial) {
  let provider = initial;
  const listeners = new Set();
  return {
    get provider() {
      return provider;
    },
    subscribeProvider(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(next) {
      provider = next;
      for (const listener of listeners) listener({ provider });
    },
  };
}
const finished = (provider, text) =>
  provider === 'gemini'
    ? { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }
    : { content: { role: 'assistant', content: text }, finishReason: 'stop' };
const toolCall = (provider) =>
  provider === 'gemini'
    ? {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'set_timeline', args: { hours_back: 24 } },
            },
          ],
        },
      }
    : {
        content: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'time',
              type: 'function',
              function: {
                name: 'set_timeline',
                arguments: '{"hours_back":24}',
              },
            },
          ],
        },
      };

for (const provider of ['openai', 'gemini']) {
  test(`${provider}: a failed continuation preserves applied steps instead of inviting a replay`, async () => {
    let requests = 0;
    let zooms = 0;
    const agent = createProviderTextAgent({
      selection: selected(provider),
      storage: { getItem: () => null },
      run: async () => {
        zooms++;
        return { ok: true };
      },
      fetchImpl: async () => {
        if (++requests > 1)
          return Response.json({ code: 'RATE_LIMITED' }, { status: 429 });
        const call = { name: 'adjust_camera_zoom', args: { direction: 'in' } };
        return Response.json(
          provider === 'gemini'
            ? { content: { role: 'model', parts: [{ functionCall: call }] } }
            : {
                content: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'zoom',
                      type: 'function',
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.args),
                      },
                    },
                  ],
                },
              },
        );
      },
    });
    const reply = await agent.ask('Zoom in');
    assert.equal(zooms, 1);
    assert.equal(reply.partial, true);
    assert.equal(reply.cancelled, false);
    assert.equal(reply.steps.length, 1);
    assert.equal(reply.steps[0].result.ok, true);
    assert.match(reply.say, /Too many chat requests/);
    assert.equal(agent.state().status, 'unavailable');
    assert.equal(agent.ready(), false);
    agent.close();
  });

  test(`${provider}: the shared HTTP session keeps context and runs the map tool profile`, async () => {
    const requests = [];
    const actions = [];
    const prepared = [];
    const agent = createProviderTextAgent({
      selection: selected(provider),
      run: async (name, args) => {
        actions.push({ name, args });
        return { ok: true, privateRows: [1, 2, 3] };
      },
      beforeTool: async (name) => prepared.push(name),
      toModel: () => ({ ok: true, summary: 'Yesterday' }),
      history: () => [{ q: 'Earlier question', say: 'Earlier answer' }],
      toolProfile: 'map-chat',
      extraTools: MAP_CHAT_TOOLS,
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return Response.json(
          requests.length === 1
            ? toolCall(provider)
            : finished(provider, 'Yesterday is on screen.'),
        );
      },
    });
    const reply = await agent.ask('Show yesterday');
    assert.equal(reply.say, 'Yesterday is on screen.');
    assert.deepEqual(actions, [
      { name: 'set_timeline', args: { hours_back: 24 } },
    ]);
    assert.deepEqual(prepared, ['set_timeline']);
    assert.equal(
      reply.steps[0].result.privateRows.length,
      3,
      'the shell keeps the full tool result',
    );
    assert.ok(
      requests.every(
        ({ url, body }) =>
          url === `/api/${provider}/chat` && body.toolProfile === 'map-chat',
      ),
    );
    assert.match(JSON.stringify(requests[0].body), /Earlier question/);
    assert.match(JSON.stringify(requests[0].body), /Earlier answer/);
    assert.match(JSON.stringify(requests[1].body), /Yesterday/);
    assert.doesNotMatch(JSON.stringify(requests[1].body), /privateRows/);
    assert.equal(agent.state().provider, provider);
    assert.equal(agent.state().status, 'ready');
    agent.close();
  });
}

test('an action still running at timeout has an unknown partial outcome and cannot trigger a replay', async () => {
  const action = deferred();
  const agent = createHttpTextAgent({
    provider: 'openai',
    timeoutMs: 10,
    run: async () => {
      await action.promise;
      return { ok: true };
    },
    fetchImpl: async () => Response.json(toolCall('openai')),
  });
  const reply = await agent.ask('Apply an action');
  assert.equal(reply.partial, true);
  assert.equal(reply.steps.length, 1);
  assert.equal(
    reply.steps[0].result.ok,
    false,
    'an unfinished action is never presented as successful',
  );
  action.resolve();
  await tick();
  agent.close();
});

test('switching providers cancels the old reply and waits for its in-flight action before new work', async () => {
  const selection = selected('openai');
  const action = deferred();
  const entered = deferred();
  const urls = [];
  let oldSignal;
  const agent = createProviderTextAgent({
    selection,
    run: async (_name, _args, { signal }) => {
      oldSignal = signal;
      entered.resolve();
      await action.promise;
      return { ok: true };
    },
    history: () => [{ q: 'A saved investigation', say: 'Its last answer' }],
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json(
        url.includes('gemini')
          ? finished('gemini', 'New provider')
          : toolCall('openai'),
      );
    },
  });
  const old = agent.ask('Old question');
  await entered.promise;
  selection.select('gemini');
  assert.equal(oldSignal.aborted, true);
  const next = agent.ask('New question');
  await tick();
  assert.deepEqual(
    urls,
    ['/api/openai/chat'],
    'a late action still owns the stage until it settles',
  );
  action.resolve();
  assert.deepEqual(await old, { cancelled: true });
  assert.equal((await next).say, 'New provider');
  assert.deepEqual(urls, ['/api/openai/chat', '/api/gemini/chat']);
  agent.close();
});

test('selected ChatGPT OAuth uses the shared realtime backend and canonical extra capabilities', async () => {
  const realtime = fakeRealtime([
    [call('set_timeline', { hours_back: 24 })],
    [say('Yesterday is on screen.')],
  ]);
  const tokens = [];
  const ran = [];
  const agent = createProviderTextAgent({
    selection: selected('openai'),
    storage: {
      getItem: (key) => (key === CLOUD_VOICE_AUTH_STORAGE_KEY ? 'oauth' : null),
    },
    toolProfile: 'map-chat',
    extraTools: MAP_CHAT_TOOLS,
    history: () => [{ q: 'Earlier', say: 'Saved answer' }],
    run: async (name, args) => {
      ran.push({ name, args });
      return { ok: true };
    },
    fetchImpl: async (url) => {
      tokens.push(url);
      return Response.json({
        value: 'ephemeral-test',
        session: {
          model: 'm',
          tools: [{ type: 'function', name: 'get_weather' }],
        },
      });
    },
    connect: realtime.connect,
  });
  const reply = await agent.ask('Show yesterday');
  assert.equal(reply.say, 'Yesterday is on screen.');
  assert.deepEqual(tokens, ['/api/realtime/token?tier=standard&auth=oauth']);
  assert.deepEqual(ran, [{ name: 'set_timeline', args: { hours_back: 24 } }]);
  const update = realtime.sent.find((event) => event.type === 'session.update');
  assert.ok(update.session.tools.some((tool) => tool.name === 'set_timeline'));
  assert.ok(update.session.tools.some((tool) => tool.name === 'get_weather'));
  assert.match(JSON.stringify(realtime.sent), /Saved answer/);
  assert.equal(agent.state().authMode, 'oauth');
  agent.close();
});

test('OAuth continuation failure preserves applied steps as partial and reports the provider unavailable', async () => {
  const realtime = fakeRealtime([
    [call('adjust_camera_zoom', { direction: 'in' })],
  ]);
  let zooms = 0;
  let rounds = 0;
  const agent = createProviderTextAgent({
    selection: { ...selected('openai'), authMode: 'oauth' },
    run: async () => {
      zooms++;
      return { ok: true };
    },
    fetchImpl: async () =>
      Response.json({ value: 'ephemeral-fixture', session: { model: 'm' } }),
    connect(url, protocols) {
      const socket = realtime.connect(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        if (JSON.parse(raw).type === 'response.create' && ++rounds === 2) {
          queueMicrotask(() =>
            socket.onmessage({
              data: JSON.stringify({
                type: 'error',
                error: {
                  code: 'upstream_failure',
                  message: 'Fixture continuation failed',
                },
              }),
            }),
          );
        } else send(raw);
      };
      return socket;
    },
  });
  const reply = await agent.ask('Zoom in');
  assert.equal(zooms, 1);
  assert.equal(reply.partial, true);
  assert.equal(reply.steps[0].result.ok, true);
  assert.equal(reply.say, 'Fixture continuation failed');
  assert.equal(agent.state().status, 'unavailable');
  agent.close();
});

test('Stop resolves promptly while a stage handoff still waits for the old action to settle', async () => {
  const entered = deferred();
  const action = deferred();
  const agent = createProviderTextAgent({
    selection: selected('gemini'),
    run: async () => {
      entered.resolve();
      await action.promise;
      return { ok: true };
    },
    fetchImpl: async () => Response.json(toolCall('gemini')),
  });
  const reply = agent.ask('Apply an action');
  await entered.promise;
  agent.cancel();
  assert.deepEqual(await reply, { cancelled: true });
  let settled = false;
  const handoff = agent.settled().then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  action.resolve();
  await handoff;
  assert.equal(settled, true);
  agent.close();
});

test('missing selected-provider credentials surface state and back off; a provider change resets the retry', async () => {
  let now = 0;
  const selection = selected('openai');
  const states = [];
  const agent = createProviderTextAgent({
    selection,
    now: () => now,
    run: async () => ({ ok: true }),
    fetchImpl: async () =>
      Response.json({ code: 'API_KEY_MISSING' }, { status: 503 }),
  });
  agent.subscribe((state) => states.push(state));
  await assert.rejects(
    agent.ask('Hello'),
    (error) => error.code === 'API_KEY_MISSING',
  );
  assert.equal(agent.state().status, 'unavailable');
  assert.match(agent.state().detail, /OPENAI_API_KEY/);
  assert.equal(agent.ready(), false);
  now = 600_001;
  assert.equal(agent.ready(), true);
  selection.select('gemini');
  assert.equal(agent.state().provider, 'gemini');
  assert.equal(agent.state().status, 'idle');
  assert.equal(agent.ready(), true);
  assert.ok(states.some((state) => state.status === 'unavailable'));
  agent.close();
});

test('cancelling HTTP acquisition settles promptly and never runs a late tool response', async () => {
  const response = deferred();
  let requestSignal;
  let calls = 0;
  const agent = createProviderTextAgent({
    selection: selected('gemini'),
    run: async () => {
      calls++;
      return { ok: true };
    },
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return response.promise;
    },
  });
  const pending = agent.ask('Hello');
  await tick();
  agent.cancel();
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(requestSignal.aborted, true);
  response.resolve(Response.json(toolCall('gemini')));
  await tick();
  assert.equal(calls, 0);
  agent.close();
});

test('two questions dispatched before transport startup keep only the newest owner', async () => {
  const texts = [];
  const agent = createProviderTextAgent({
    selection: selected('gemini'),
    run: async () => ({ ok: true }),
    fetchImpl: async (_url, { body }) => {
      texts.push(JSON.parse(body).contents.at(-1).parts[0].text);
      return Response.json(finished('gemini', 'Latest reply'));
    },
  });
  const first = agent.ask('Old');
  const second = agent.ask('Newest');
  assert.deepEqual(await first, { cancelled: true });
  assert.equal((await second).say, 'Latest reply');
  assert.deepEqual(texts, ['Newest']);
  agent.close();
});
