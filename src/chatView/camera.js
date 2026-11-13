import { delay } from './wait.js';

const SETTLE_MS = 3500;
// The longest a step waits for a flight in progress to land.
const ARRIVE_MS = 8000;

/**
 * The camera as the kernel sees it, from its own move events: whether it
 * is moving (a flight, a drag), when it is still, and when a flight in
 * progress has landed.
 * @param {{onMoveStart: Function, onMoveEnd: Function}} camera Each takes a
 *   listener and returns its remover.
 */
export function createCameraWatch(camera) {
  let moving = false;
  const offStart = camera.onMoveStart(() => {
    moving = true;
  });
  const offEnd = camera.onMoveEnd(() => {
    moving = false;
  });
  // The next stop, or `ms` from now, or the signal's abort.
  const nextStop = (ms, signal) =>
    new Promise((resolve) => {
      let off = null;
      let timer = null;
      const finish = () => {
        off?.();
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      off = camera.onMoveEnd(finish);
      timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
    });
  return {
    /** Resolves when the camera next stops, or after a few seconds. */
    still: () => nextStop(SETTLE_MS),
    /** Resolves when a flight in progress has landed, at once when none is. */
    async arrive(signal) {
      // A flight just asked for starts moving on the next frame.
      await delay(150, signal);
      if (!moving || signal?.aborted) return;
      await nextStop(ARRIVE_MS, signal);
    },
    destroy() {
      offStart();
      offEnd();
    },
  };
}
