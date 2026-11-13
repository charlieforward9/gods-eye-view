/** The map shell consumes the same provider facade as the desktop controls. */
export function createChatAgent({ provider, ...options }) {
  if (typeof provider?.createTextAgent !== 'function')
    throw new TypeError(
      'The map chat requires the application provider facade',
    );
  return provider.createTextAgent({ ...options, toolProfile: 'map-chat' });
}
