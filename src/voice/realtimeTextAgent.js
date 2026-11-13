import { waitForSignal } from '../sources/requestDeadline.js';

/**
 * GEV's own agent, typed to. The desktop voice agent is OpenAI Realtime
 * with the app's instructions, its actions and its query tools, minted by
 * the app's server (an API key or the ChatGPT sign-in). The chat view opens
 * the same session over a WebSocket with text in and text out, runs every
 * tool call through the same runner the desktop agent uses, and hands back
 * the agent's words with the steps it took, so the answer can show rows, a
 * follow and a view like any other.
 *
 * One connection while the chat view is open, one conversation per session:
 * `reset()` clears the conversation on the same connection, and a new
 * conversation is told the session's last few questions and answers.
 */
const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MODEL = 'gpt-realtime-2';
// Tool rounds one question may take before the agent must answer.
const MAX_ROUNDS = 8;
const RESPONSE_TIMEOUT_MS = 45_000;
// After a failed connection, the rule planner answers for this long; a
// server with no agent set up (no key, no ChatGPT sign-in) is asked again
// far less often.
const RETRY_AFTER_MS = 60_000;
const UNCONFIGURED_RETRY_MS = 10 * 60_000;
const HISTORY_TURNS = 4;

const message = (role, text) => ({
  type: 'conversation.item.create',
  item: {
    type: 'message',
    role,
    content: [
      { type: role === 'assistant' ? 'output_text' : 'input_text', text },
    ],
  },
});

/** The words and function calls a finished response holds. */
export function readResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const text = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .map((part) => part.text || part.transcript || '')
    .join(' ')
    .trim();
  const calls = output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments || '{}',
    }));
  return { status: response?.status || 'completed', text, calls };
}

/**
 * @param {{requestToken: Function, run: Function, beforeTool?: Function,
 *   connect?: Function, history?: Function, extraTools?: Array<object>,
 *   toModel?: Function, now?: Function}} options
 *   `requestToken({signal})` resolves `{token, model, tools}` (the server's
 *   Realtime session and the tools it minted it with) and rejects with
 *   `unconfigured: true` when the server has no agent set up;
 *   `extraTools` join the session's tools; `run(name, args, {signal})` is
 *   the desktop agent's runner; `toModel(name, result)` is what the agent
 *   reads of a result; `beforeTool(name, args, {signal})` may wait (a
 *   layer's first records); `history()` lists the session's earlier
 *   `{q, say}` turns.
 */
export function createRealtimeTextAgent({
  requestToken,
  run,
  beforeTool = async () => {},
  connect = (url, protocols) => new globalThis.WebSocket(url, protocols),
  history = () => [],
  extraTools = [],
  toModel = (_name, result) => result,
  now = Date.now,
  instructions = '',
}) {
  const lifetime = new AbortController();
  let connection = null;
  let failedAt = -Infinity;
  let retryMs = RETRY_AFTER_MS;
  let turn = null;
  // The conversation's items, so a new conversation can clear them on the
  // same connection (each new connection mints a session, and the server
  // limits how often), and whether it has heard the typed-mode note and
  // the session's history.
  const items = new Set();
  let primed = false;
  // The open socket, for a retried response.create.
  let live = null;

  const send = (socket, event) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(event));
  };

  function open() {
    const opening = (async () => {
      const { token, model, tools } = await requestToken({
        signal: lifetime.signal,
      });
      lifetime.signal.throwIfAborted();
      const socket = connect(
        `${REALTIME_URL}?model=${encodeURIComponent(model || DEFAULT_MODEL)}`,
        ['realtime', `openai-insecure-api-key.${token}`],
      );
      await new Promise((resolve, reject) => {
        const abort = () => {
          socket.close();
          reject(lifetime.signal.reason);
        };
        const settle =
          (callback) =>
          (...args) => {
            lifetime.signal.removeEventListener('abort', abort);
            callback(...args);
          };
        lifetime.signal.addEventListener('abort', abort, { once: true });
        socket.onopen = settle(resolve);
        socket.onerror = settle(() =>
          reject(new Error('GEV’s agent did not connect')),
        );
        socket.onclose = settle(() =>
          reject(new Error('GEV’s agent did not connect')),
        );
      });
      socket.onmessage = (event) => {
        try {
          receive(JSON.parse(event.data));
        } catch {
          // A frame that is not JSON is not ours to answer.
        }
      };
      socket.onerror = null;
      socket.onclose = () => {
        if (connection === opening) connection = null;
        turn?.waiter?.reject(new Error('GEV’s agent disconnected'));
      };
      // Text in and out; the session keeps the desktop's instructions and
      // tools as the server minted them, with the chat view's own after them. A tool
      // list replaces the session's, so extras join only a known list.
      send(socket, {
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['text'],
          audio: { input: { turn_detection: null } },
          ...(Array.isArray(tools) && tools.length && extraTools.length
            ? {
                tools: [
                  ...tools,
                  ...extraTools.filter(
                    (extra) => !tools.some((tool) => tool.name === extra.name),
                  ),
                ],
              }
            : {}),
        },
      });
      items.clear();
      primed = false;
      live = socket;
      return socket;
    })();
    connection = opening;
    opening.catch((error) => {
      if (connection === opening) connection = null;
      failedAt = now();
      retryMs = error?.unconfigured ? UNCONFIGURED_RETRY_MS : RETRY_AFTER_MS;
    });
    return opening;
  }

  // The typed-mode note and the session's last questions, once per
  // conversation.
  function prime(socket) {
    if (primed) return;
    primed = true;
    if (instructions) send(socket, message('system', instructions));
    for (const earlier of history().slice(-HISTORY_TURNS)) {
      if (!earlier?.q || !earlier?.say) continue;
      send(socket, message('user', earlier.q));
      send(socket, message('assistant', earlier.say));
    }
  }

  function receive(event) {
    if (
      /^conversation\.item\.(added|created)$/.test(event.type) &&
      event.item?.id
    )
      items.add(event.item.id);
    else if (event.type === 'conversation.item.deleted')
      items.delete(event.item_id);
    const waiter = turn?.waiter;
    if (!waiter) return;
    if (event.type === 'response.created' && !waiter.responseId)
      waiter.responseId = event.response?.id || null;
    else if (event.type === 'response.done') {
      const id = event.response?.id;
      // A cancelled response is a superseded question's, never this one's
      // answer; if this turn took its id, the next response is ours.
      if (event.response?.status === 'cancelled') {
        if (waiter.responseId === id) waiter.responseId = null;
        return;
      }
      if (!waiter.responseId || id === waiter.responseId)
        waiter.resolve(readResponse(event.response));
    } else if (event.type === 'error') {
      const code = event.error?.code || '';
      // The superseded response has not finished cancelling: ask again.
      if (/active_response/i.test(code)) {
        setTimeout(() => send(live, { type: 'response.create' }), 250);
        return;
      }
      // Cancelling a response that already ended is not a failure.
      if (!/cancel/i.test(code))
        waiter.reject(new Error(event.error?.message || 'GEV’s agent failed'));
    }
  }

  // The next finished response of this turn.
  function nextResponse(current, socket) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('GEV’s agent took too long')),
        RESPONSE_TIMEOUT_MS,
      );
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        if (current.waiter === waiter) current.waiter = null;
        fn(value);
      };
      const waiter = {
        responseId: null,
        resolve: settle(resolve),
        reject: settle(reject),
      };
      current.waiter = waiter;
      current.controller.signal.addEventListener(
        'abort',
        () => waiter.reject(new Error('cancelled')),
        { once: true },
      );
      send(socket, { type: 'response.create' });
    });
  }

  function cancel() {
    const current = turn;
    if (!current) return;
    turn = null;
    current.controller.abort();
    connection?.then(
      (socket) => {
        send(socket, { type: 'response.cancel' });
        // A call left without an output strands the conversation.
        for (const callId of current.open)
          send(socket, {
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ ok: false, cancelled: true }),
            },
          });
      },
      () => {},
    );
  }

  return {
    /** Whether a question should try the agent now. */
    ready: () => now() - failedAt >= retryMs,

    /** Open the connection ahead of the first question. */
    warm() {
      if (!connection && now() - failedAt >= retryMs) open().catch(() => {});
    },

    /** A new conversation for the next question (a new or other session). */
    reset() {
      cancel();
      connection?.then(
        (socket) => {
          for (const id of items)
            send(socket, { type: 'conversation.item.delete', item_id: id });
          items.clear();
          primed = false;
        },
        () => {},
      );
    },

    /** Close the connection (the page is going away). */
    close() {
      cancel();
      lifetime.abort();
      const closing = connection;
      connection = null;
      closing?.then(
        (socket) => socket.close(),
        () => {},
      );
    },

    cancel,

    /**
     * Ask the agent. Resolves `{cancelled: true}` when superseded, else
     * `{say, steps}`; rejects when the agent cannot be reached.
     * @param {string} text What the person typed, with any context line.
     * @param {{signal?: AbortSignal, onStep?: Function}} [options]
     */
    async ask(text, { signal, onStep } = {}) {
      cancel();
      const current = {
        controller: new AbortController(),
        waiter: null,
        open: new Set(),
      };
      turn = current;
      signal?.addEventListener('abort', () => current.controller.abort(), {
        once: true,
      });
      let socket;
      try {
        socket = await waitForSignal(
          connection || open(),
          current.controller.signal,
        );
      } catch (error) {
        if (current.controller.signal.aborted) return { cancelled: true };
        throw error;
      }
      if (current.controller.signal.aborted) return { cancelled: true };
      const steps = [];
      let said = '';
      prime(socket);
      send(socket, message('user', text));
      try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          const response = await nextResponse(current, socket);
          if (response.text) {
            said = response.text;
            if (response.calls.length) onStep?.(response.text);
          }
          if (!response.calls.length || response.status !== 'completed') break;
          for (const call of response.calls) current.open.add(call.callId);
          for (const call of response.calls) {
            let args = {};
            try {
              args = JSON.parse(call.arguments) || {};
            } catch {
              // The runner answers bad arguments itself.
            }
            const step = { name: call.name, args, result: null };
            onStep?.(null, step);
            await beforeTool(call.name, args, {
              signal: current.controller.signal,
            });
            current.controller.signal.throwIfAborted();
            try {
              step.result = await run(call.name, args, {
                signal: current.controller.signal,
              });
            } catch (error) {
              step.result = {
                ok: false,
                error: error?.message || String(error),
              };
            }
            if (current.controller.signal.aborted) return { cancelled: true };
            steps.push(step);
            send(socket, {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: call.callId,
                output: JSON.stringify(
                  toModel(call.name, step.result) ?? { ok: true },
                ),
              },
            });
            current.open.delete(call.callId);
          }
        }
      } catch (error) {
        if (current.controller.signal.aborted) return { cancelled: true };
        // Completed actions stand, but a failed continuation is not a complete
        // answer. Preserve the steps so hosts cannot replay the request.
        if (steps.length || said)
          return {
            cancelled: false,
            partial: true,
            say: error?.message || 'GEV’s agent disconnected',
            detail: error?.message || 'GEV’s agent disconnected',
            failure: {
              code: error?.code,
              status: error?.status,
              unconfigured: Boolean(error?.unconfigured),
            },
            steps,
          };
        throw error;
      } finally {
        if (turn === current) turn = null;
      }
      return { cancelled: false, say: said, steps };
    },
  };
}
