/**
 * What a question's words do not carry: what was tapped, where the person
 * is, the view, and the time the timeline shows. Chips are what the
 * composer shows; the context line is what GEV's agent reads.
 */
import { t } from '../i18n/index.js';
import { parseSlash } from './commands.js';
import { windowOf } from './timeWindow.js';

// "Over me", "near me", "where am I": the device's place, not a guess.
const ABOUT_ME =
  /\b(over|near|around|above) me\b|\bwhere (i am|am i)\b|\bmy location\b|^find me\b/i;
// The ones a view cannot stand in for.
const ONLY_HERE = /\bwhere (i am|am i)\b|^find me\b|\bmy location\b/i;
export const CAMERA_QUESTION = /\b(cameras?|cams?|cctv|webcams?)\b/i;
const CAMERA_DESTINATION =
  /\b(?:nearest|closest)(?:\s+(?:live|traffic|road|cctv|cameras?|cams?|webcams?))*\s+to\s+(.+)$/i;
const DEVICE_CAMERA_LOCATION =
  /\b(?:near|around|close\s+to|next\s+to)\s+(?:me|my\s+area)\b|\bmy\s+(?:current\s+)?location\b|\bwhere\s+i\s+am\b/i;
const LABEL_MAX = 80;

/** The destination in camera wording such as "nearest CCTV to Tequesta". */
export function cameraDestination(question) {
  return CAMERA_DESTINATION.exec(question)?.[1] ?? null;
}

/** Whether the camera search explicitly refers to the device's location. */
export function asksForDeviceCameras(question) {
  return (
    CAMERA_QUESTION.test(question) &&
    (DEVICE_CAMERA_LOCATION.test(question) ||
      /^(?:me|my area)\b/i.test(cameraDestination(question) || ''))
  );
}

/**
 * A feed's own text (a callsign, a camera's name) as the agent reads it:
 * one short line that cannot pass for a bracket of context or an
 * instruction of its own.
 */
export function quoted(text) {
  const line = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f[\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `"${line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line}"`;
}

/**
 * @param {{cameraState: () => object|null, geolocate?: () => Promise<object|null>}} options
 */
export function createContext({ cameraState, geolocate = async () => null }) {
  const viewChip = () => {
    const camera = cameraState();
    return camera
      ? {
          kind: 'view',
          label: t('This view'),
          lat: camera.lat,
          lon: camera.lon,
        }
      : null;
  };
  const hereChip = async () => {
    const at = await geolocate().catch(() => null);
    return at
      ? { kind: 'here', label: t('Here'), lat: at.lat, lon: at.lon }
      : null;
  };
  return {
    viewChip,
    hereChip,
    /**
     * Nearby CCTV searches require a device location. Other relative
     * questions keep the view fallback when the device location is missing.
     */
    async implied(question, chips) {
      const deviceCameras = asksForDeviceCameras(question);
      if (deviceCameras && question.trimStart().startsWith('/')) {
        const command = parseSlash(question)?.command.id;
        if (command !== 'cameras' && command !== 'find') return chips;
      }
      if (
        !(deviceCameras || ABOUT_ME.test(question)) ||
        chips.some((chip) => chip.kind === 'here')
      )
        return chips;
      const here =
        (await hereChip()) ||
        (deviceCameras || ONLY_HERE.test(question) ? null : viewChip());
      return here ? [...chips, { ...here, kind: 'here' }] : chips;
    },
    /** The question as GEV's agent reads it, with its context first. */
    forAgent(question, chips, time) {
      const lines = [];
      for (const chip of chips) {
        const at =
          Number.isFinite(chip.lat) && Number.isFinite(chip.lon)
            ? ` at ${chip.lat.toFixed(4)}, ${chip.lon.toFixed(4)}`
            : '';
        if (chip.kind === 'object')
          lines.push(
            `Selected on the globe: ${quoted(chip.label)}${chip.layerId ? ` (${chip.layerId} layer)` : ''}${at}.`,
          );
        else if (chip.kind === 'here') lines.push(`The user is${at}.`);
        else if (chip.kind === 'view')
          lines.push(`About the current view${at}.`);
      }
      const range = windowOf(time);
      if (range)
        lines.push(
          `The timeline shows ${new Date(range.fromMs).toISOString()} to ${new Date(range.toMs).toISOString()}.`,
        );
      return lines.length ? `[${lines.join(' ')}]\n${question}` : question;
    },
  };
}
