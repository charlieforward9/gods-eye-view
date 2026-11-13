import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';

/**
 * The chat view as its shell renders it: the kernel's latest snapshot
 * (sessions, the open answer, layers, time) and the kernel's intents through
 * act(). Each snapshot keeps the parts that did not change, so a view
 * re-renders only when what it shows does, and never reads the engine. The page's mode switch
 * offers the way in and out (switchTo), once the globe is up.
 */
export const useChatViewStore = defineStore('gev-chat-view', () => {
  /** @type {import('vue').ShallowRef<object|null>} null until the globe is up. */
  const snapshot = shallowRef(null);
  /** Whether the page can switch between the chat view and the panels. */
  const switchable = ref(false);
  let kernel = null;
  let modes = null;

  /**
   * Mirror a kernel; returns the disconnect.
   * @param {object} next From createChatViewKernel().
   */
  function connect(next) {
    kernel = next;
    const unsubscribe = next.subscribe((value) => {
      snapshot.value = value;
    });
    return () => {
      unsubscribe();
      if (kernel !== next) return;
      kernel = null;
      snapshot.value = null;
    };
  }

  /**
   * Run a kernel intent (src/chatView/intents.js); it always resolves, to
   * undefined until the kernel connects.
   */
  function act(name, ...args) {
    return kernel ? kernel.act(name, ...args) : Promise.resolve(undefined);
  }

  /**
   * The page's switch takes 'chat' and 'panels'.
   * @param {{open: Function, close: Function}} next
   */
  function offerSwitch(next) {
    modes = next;
    switchable.value = Boolean(next);
  }

  /** @param {'chat'|'panels'} mode */
  function switchTo(mode) {
    return mode === 'chat' ? modes?.open() : modes?.close();
  }

  return { snapshot, switchable, connect, act, offerSwitch, switchTo };
});
