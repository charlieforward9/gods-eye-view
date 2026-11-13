import { MAP_CHAT_INSTRUCTIONS } from '../voice/mapChatTools.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRealtimeTextAgent as createChatAgent,
  readResponse,
} from '../voice/realtimeTextAgent.js';
import {
  AGENT_TOOLS,
  TIMELINE_DAYS,
  timelineOf,
} from './capabilities/index.js';
import { call, fakeRealtime, say } from '../testSupport/fakeRealtime.mjs';

test('a question runs the agent’s tool calls through the runner and answers in its words', async () => {
  const realtime = fakeRealtime([
    [
      say('Checking Tokyo.'),
      call('get_weather', { location: { place: 'Tokyo' } }),
    ],
    [say('Tokyo is overcast, 14°C.')],
  ]);
  const ran = [];
  const agent = createChatAgent({
    instructions: MAP_CHAT_INSTRUCTIONS,
    requestToken: async () => ({
      token: 'ek_test',
      model: 'gpt-realtime-2',
      tools: [{ type: 'function', name: 'get_weather' }],
    }),
    run: async (name, args) => {
      ran.push([name, args]);
      return { ok: true, summary: 'Overcast, 14°C' };
    },
    connect: realtime.connect,
    extraTools: AGENT_TOOLS,
  });
  const steps = [];
  const reply = await agent.ask('What’s the weather in Tokyo?', {
    onStep: (text, step) => steps.push(step ? step.name : text),
  });
  assert.equal(reply.say, 'Tokyo is overcast, 14°C.');
  assert.deepEqual(ran, [['get_weather', { location: { place: 'Tokyo' } }]]);
  assert.deepEqual(steps, ['Checking Tokyo.', 'get_weather']);
  // The session keeps the server's tools and adds the chat view's after them, text
  // in and text out.
  const update = realtime.sent.find((event) => event.type === 'session.update');
  assert.deepEqual(update.session.output_modalities, ['text']);
  assert.deepEqual(
    update.session.tools.map((tool) => tool.name),
    ['get_weather', ...AGENT_TOOLS.map((tool) => tool.name)],
  );
  assert.ok(
    realtime.socket().protocols.includes('openai-insecure-api-key.ek_test'),
  );
  const output = realtime.sent.find(
    (event) => event.item?.type === 'function_call_output',
  );
  assert.equal(output.item.call_id, 'call_1');
  assert.deepEqual(JSON.parse(output.item.output), {
    ok: true,
    summary: 'Overcast, 14°C',
  });
});

test('a fresh conversation hears the session’s last questions, and a failed connection falls back for a minute', async () => {
  const realtime = fakeRealtime([[say('Done.')]]);
  const agent = createChatAgent({
    instructions: MAP_CHAT_INSTRUCTIONS,
    requestToken: async () => ({ token: 't', model: 'm', tools: null }),
    run: async () => ({ ok: true }),
    connect: realtime.connect,
    history: () => [{ q: 'Any emergencies?', say: 'None right now.' }],
  });
  await agent.ask('And now?');
  const texts = realtime.sent
    .filter((event) => event.item?.type === 'message')
    .map((event) => `${event.item.role}: ${event.item.content[0].text}`);
  assert.deepEqual(texts.slice(1), [
    'user: Any emergencies?',
    'assistant: None right now.',
    'user: And now?',
  ]);
  // Without a known tool list, the chat view never replaces the session's tools.
  const update = realtime.sent.find((event) => event.type === 'session.update');
  assert.equal(update.session.tools, undefined);

  let clock = 0;
  const down = createChatAgent({
    instructions: MAP_CHAT_INSTRUCTIONS,
    requestToken: async () => {
      throw new Error('no sign-in');
    },
    run: async () => ({ ok: true }),
    now: () => clock,
  });
  await assert.rejects(down.ask('hello'));
  await Promise.resolve();
  assert.equal(down.ready(), false);
  clock += 61_000;
  assert.equal(down.ready(), true);
});

test('cancelling mid-tool answers the open call and resolves as cancelled', async () => {
  const realtime = fakeRealtime([
    [call('analyst_query', { layers: ['flights'] })],
  ]);
  let release;
  const agent = createChatAgent({
    instructions: MAP_CHAT_INSTRUCTIONS,
    requestToken: async () => ({ token: 't', model: 'm' }),
    run: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    connect: realtime.connect,
  });
  const asking = agent.ask('How many flights?');
  await new Promise((resolve) => setTimeout(resolve, 10));
  agent.cancel();
  release({ ok: true });
  assert.deepEqual(await asking, { cancelled: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(realtime.sent.some((event) => event.type === 'response.cancel'));
  const closing = realtime.sent.find(
    (event) => event.item?.type === 'function_call_output',
  );
  assert.deepEqual(JSON.parse(closing.item.output), {
    ok: false,
    cancelled: true,
  });
});

test('a finished response reads as its words and its calls', () => {
  assert.deepEqual(
    readResponse({
      status: 'completed',
      output: [
        say('Turning on flights.'),
        call(
          'set_layer_visibility',
          { layerId: 'flights', enabled: true },
          'c9',
        ),
      ],
    }),
    {
      status: 'completed',
      text: 'Turning on flights.',
      calls: [
        {
          callId: 'c9',
          name: 'set_layer_visibility',
          arguments: '{"layerId":"flights","enabled":true}',
        },
      ],
    },
  );
});

test('the timeline tool keeps every window inside the week the track holds', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.deepEqual(timelineOf({ live: true }, now), { mode: 'live' });
  assert.deepEqual(timelineOf({ hours_back: 72 }, now), {
    mode: 'recent',
    hours: 72,
  });
  assert.equal(timelineOf({ hours_back: 1000 }, now).hours, TIMELINE_DAYS * 24);
  const range = timelineOf(
    { from: '2026-10-01T00:00:00Z', to: '2026-11-02T00:00:00Z' },
    now,
  );
  assert.equal(range.mode, 'range');
  assert.equal(range.fromMs, now - TIMELINE_DAYS * 86_400_000);
  assert.equal(range.toMs, Date.parse('2026-11-02T00:00:00Z'));
  assert.equal(timelineOf({}, now), null);
});

test('another session clears the conversation on the same connection', async () => {
  const realtime = fakeRealtime([[say('One.')], [say('Two.')]]);
  let minted = 0;
  const agent = createChatAgent({
    instructions: MAP_CHAT_INSTRUCTIONS,
    requestToken: async () => {
      minted += 1;
      return { token: 't', model: 'm' };
    },
    run: async () => ({ ok: true }),
    connect: realtime.connect,
  });
  await agent.ask('First session');
  await new Promise((resolve) => setTimeout(resolve, 0));
  agent.reset();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const deleted = realtime.sent.filter(
    (event) => event.type === 'conversation.item.delete',
  );
  assert.ok(deleted.length >= 2);
  const reply = await agent.ask('Second session');
  assert.equal(reply.say, 'Two.');
  assert.equal(minted, 1);
  // The new conversation hears the typed-mode note again.
  const notes = realtime.sent.filter((event) => event.item?.role === 'system');
  assert.equal(notes.length, 2);
});

test('a superseded response that finishes late never answers the next question', async () => {
  const sent = [];
  let socket;
  let creates = 0;
  const emit = (event) => socket.onmessage({ data: JSON.stringify(event) });
  const connect = () => {
    socket = {
      readyState: 0,
      send(raw) {
        const event = JSON.parse(raw);
        sent.push(event);
        if (event.type !== 'response.create') return;
        creates += 1;
        // The first question's response starts and then hangs.
        if (creates === 1)
          queueMicrotask(() =>
            emit({ type: 'response.created', response: { id: 'old' } }),
          );
        // The second's: the old one's late cancellation lands first.
        else
          queueMicrotask(() => {
            emit({
              type: 'response.done',
              response: { id: 'old', status: 'cancelled', output: [] },
            });
            emit({ type: 'response.created', response: { id: 'new' } });
            emit({
              type: 'response.done',
              response: {
                id: 'new',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'output_text', text: 'Fresh.' }],
                  },
                ],
              },
            });
          });
      },
      close() {},
    };
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.onopen();
    });
    return socket;
  };
  const agent = createChatAgent({
    instructions: MAP_CHAT_INSTRUCTIONS,
    requestToken: async () => ({ token: 't', model: 'm' }),
    run: async () => ({ ok: true }),
    connect,
  });
  const first = agent.ask('What is flying over Tokyo?');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await agent.ask('Earthquakes in the last day');
  assert.deepEqual(await first, { cancelled: true });
  assert.equal(second.say, 'Fresh.');
});
