import { createVoiceSession } from './session.js';
import { createTextChat } from './textChat.js';
import { createRealtimeTextAgent } from './realtimeTextAgent.js';
import { createRealtimeBackend } from './realtimeBackend.js';
import { readStoredCloudVoiceAuthMode } from './cloudVoiceAuth.js';
import { MAP_CHAT_INSTRUCTIONS } from './mapChatTools.js';

/** Promise-shaped host interface over the desktop's neutral text session. */
export function createHttpTextAgent({
  provider,
  run,
  beforeTool = async () => {},
  toModel = (_name, result) => result,
  history = () => [],
  fetchImpl,
  toolProfile,
  onState = () => {},
  timeoutMs,
}) {
  let pending = null;
  let request = 0;
  const session = createVoiceSession({
    runner: async (name, args, options) => {
      const current = pending;
      const step = { name, args, result: null };
      current?.activeSteps.add(step);
      current?.onStep?.(null, step);
      try {
        await beforeTool(name, args, options);
        options.signal.throwIfAborted();
        try {
          step.result = await run(name, args, options);
        } catch (error) {
          options.signal.throwIfAborted();
          step.result = { ok: false, error: error?.message || 'Action failed' };
        }
        options.signal.throwIfAborted();
        current?.steps.push(step);
        return toModel(name, step.result) ?? { ok: true };
      } finally {
        current?.activeSteps.delete(step);
      }
    },
    createAdapter: (hooks) =>
      createTextChat({
        ...hooks,
        provider,
        fetchImpl,
        initialHistory: history,
        toolProfile,
        ...(timeoutMs !== undefined && { timeoutMs }),
      }),
  });
  const off = session.subscribe((event) => {
    if (event.type === 'state') {
      onState(event.state, event.detail);
      if (event.state === 'error' && pending) {
        const current = pending;
        pending = null;
        const failure = {
          code: event.code,
          status: event.status,
          unconfigured: event.code === 'API_KEY_MISSING',
        };
        // A failed continuation must not invite a host to replay the original
        // request after actions already ran. An unfinished action has an unknown
        // outcome, so retain it as failed/partial instead of claiming success.
        if (current.steps.length || current.activeSteps.size) {
          current.resolve({
            cancelled: false,
            partial: true,
            say: event.detail,
            detail: event.detail,
            failure,
            steps: [
              ...current.steps,
              ...[...current.activeSteps].map((step) => ({
                ...step,
                result: { ok: false, partial: true, error: event.detail },
              })),
            ],
          });
          return;
        }
        current.reject(
          Object.assign(new Error(event.detail), {
            ...failure,
          }),
        );
      }
    }
    if (!pending) return;
    if (event.type === 'transcript' && event.role === 'assistant')
      pending.say = event.text;
    if (event.type === 'completion') {
      const current = pending;
      pending = null;
      current.resolve(
        event.status === 'cancelled'
          ? { cancelled: true }
          : { cancelled: false, say: current.say, steps: current.steps },
      );
    }
  });
  const cancel = () => {
    request++;
    session.adapter.cancelTurn();
    if (pending) {
      pending.resolve({ cancelled: true });
      pending = null;
    }
  };
  return {
    ready: () => !session.disposed,
    warm() {},
    cancel,
    reset() {
      cancel();
      session.stop();
    },
    close() {
      cancel();
      off();
      session.destroy();
    },
    async ask(text, { signal, onStep } = {}) {
      cancel();
      const owner = request;
      if (signal?.aborted) return { cancelled: true };
      if (!session.isActive()) await session.start({ textOnly: true });
      if (signal?.aborted || owner !== request) return { cancelled: true };
      const result = new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          onStep,
          say: '',
          steps: [],
          activeSteps: new Set(),
        };
      });
      signal?.addEventListener('abort', cancel, { once: true });
      if (!session.sendText(text)) {
        const current = pending;
        pending = null;
        current?.reject(new Error('The text session is unavailable'));
      }
      try {
        return await result;
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

/**
 * An application's selected provider, shared by every host. HTTP chat uses the
 * same bounded tool loop as the desktop. ChatGPT OAuth uses the shared Realtime
 * backend because the HTTP OpenAI route can bill only an API key.
 */
export function createProviderTextAgent({
  selection,
  run,
  beforeTool,
  toModel,
  history,
  extraTools = [],
  toolProfile,
  storage,
  signal,
  fetchImpl = (...args) => fetch(...args),
  connect,
  now = Date.now,
  factories = {},
}) {
  const listeners = new Set();
  const actions = new Set();
  let transport = null;
  let identity = null;
  let disposed = false;
  let generation = 0;
  let failedAt = -Infinity;
  let retryMs = 0;
  let status = 'idle';
  let detail = '';
  let pending = null;
  let request = 0;
  const provider = () => selection.provider;
  const authMode = () =>
    provider() === 'openai'
      ? (selection.authMode ?? readStoredCloudVoiceAuthMode(storage))
      : 'api-key';
  const state = () =>
    Object.freeze({
      provider: provider(),
      authMode: authMode(),
      status,
      detail,
      retryAt: Number.isFinite(failedAt) ? failedAt + retryMs : null,
    });
  const publish = (next, message = '') => {
    if (disposed) return;
    status = next;
    detail = message || '';
    const value = state();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        /* A shell observer cannot interrupt the provider's turn. */
      }
    }
  };
  const retire = () => {
    generation++;
    request++;
    transport?.cancel();
    transport?.close();
    transport = null;
    identity = null;
    failedAt = -Infinity;
    retryMs = 0;
  };
  const offProvider = selection.subscribeProvider?.(() => {
    retire();
    publish('idle');
  });
  const ensure = () => {
    const next = `${provider()}:${authMode()}`;
    if (identity !== next) retire();
    if (transport) return transport;
    identity = next;
    const epoch = generation;
    const options = {
      provider: provider(),
      run(name, args, settings) {
        // An adapter may finish its cancellation before a host's in-flight
        // action settles. The next provider/session waits for those actions.
        const work = Promise.resolve().then(() => {
          settings?.signal?.throwIfAborted();
          return run(name, args, settings);
        });
        actions.add(work);
        void work.finally(() => actions.delete(work)).catch(() => {});
        return work;
      },
      beforeTool,
      toModel,
      history,
      extraTools,
      toolProfile,
      fetchImpl,
      onState(nextStatus, message) {
        if (epoch === generation) publish(nextStatus, message);
      },
    };
    if (provider() === 'openai' && authMode() === 'oauth') {
      const backend = createRealtimeBackend({ tokenTransport: fetchImpl });
      transport = (factories.realtime || createRealtimeTextAgent)({
        ...options,
        requestToken: ({ signal: tokenSignal } = {}) =>
          backend.requestToken({ authMode: 'oauth', signal: tokenSignal }),
        ...(connect && { connect }),
        instructions: toolProfile === 'map-chat' ? MAP_CHAT_INSTRUCTIONS : '',
      });
    } else {
      transport = (factories.http || createHttpTextAgent)(options);
    }
    return transport;
  };
  const cancel = () => {
    request++;
    transport?.cancel();
  };
  const close = () => {
    if (disposed) return;
    retire();
    disposed = true;
    offProvider?.();
    listeners.clear();
    signal?.removeEventListener('abort', close);
  };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return {
    state,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(state());
      return () => listeners.delete(listener);
    },
    ready: () => !disposed && now() - failedAt >= retryMs,
    warm() {},
    cancel,
    /** Stage handoffs wait for actions even though Stop resolves promptly. */
    settled: () => Promise.allSettled([...actions]),
    reset() {
      cancel();
      transport?.reset();
      publish('idle');
    },
    close,
    async ask(text, settings = {}) {
      if (disposed) return { cancelled: true };
      cancel();
      const epoch = generation;
      const started = request;
      await Promise.allSettled([...actions]);
      if (
        disposed ||
        epoch !== generation ||
        started !== request ||
        settings.signal?.aborted
      )
        return { cancelled: true };
      const current = ensure();
      const owner = generation;
      const ownerRequest = request;
      publish('connecting');
      const work = current.ask(text, settings);
      pending = work;
      try {
        const reply = await work;
        if (disposed || owner !== generation || ownerRequest !== request)
          return { cancelled: true };
        if (reply.partial) {
          failedAt = now();
          retryMs = reply.failure?.unconfigured ? 600_000 : 60_000;
          publish('unavailable', reply.detail || reply.say);
        } else publish('ready');
        return reply;
      } catch (error) {
        if (disposed || owner !== generation || ownerRequest !== request)
          return { cancelled: true };
        failedAt = now();
        retryMs = error?.unconfigured ? 600_000 : 60_000;
        publish('unavailable', error?.message || 'The provider is unavailable');
        throw error;
      } finally {
        if (pending === work) pending = null;
      }
    },
  };
}
