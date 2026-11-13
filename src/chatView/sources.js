import { msg } from '../i18n/marker.js';

/**
 * Where an answer's numbers came from, when the provider asks to be named
 * beside its data. A layer's provider is in the map's credits already; these
 * are the ones an answer shows without turning a layer on.
 */
export const OPEN_METEO = Object.freeze({
  id: 'open-meteo',
  // Open-Meteo's licence (CC BY 4.0) asks for this link beside the data.
  label: msg('Weather data by Open-Meteo.com'),
  url: 'https://open-meteo.com/',
});

// The app's own tools whose answers come from such a provider.
const TOOL_SOURCES = Object.freeze({ get_weather: OPEN_METEO });

/**
 * The sources an answer's steps drew on, once each.
 * @param {Array<{name: string, result?: object}>} steps
 */
export function sourcesOf(steps = []) {
  const found = new Map();
  for (const step of steps) {
    if (step.result?.ok === false) continue;
    const source = step.result?.source || TOOL_SOURCES[step.name];
    if (source?.id && !found.has(source.id)) found.set(source.id, source);
  }
  return [...found.values()];
}
