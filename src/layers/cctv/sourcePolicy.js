export const FRAME_ENDPOINT = '/api/cctv/frame';

export const MEDIA_ENDPOINT = '/api/cctv/media';

export const ACTIVE_FRAME_REFRESH_MS = 10000;

/**
 * A v4 UUID for the client lease. `crypto.randomUUID` only exists in secure
 * contexts, so a page opened over plain HTTP from another machine (the
 * HOST=0.0.0.0 LAN opt-in) has none; `getRandomValues` exists in every context
 * and yields the same shape the server's lease check accepts.
 */
export function createLeaseId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl.randomUUID === 'function') {
    return cryptoImpl.randomUUID();
  }
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10),
  ]
    .map((group) => group.join(''))
    .join('-');
}
