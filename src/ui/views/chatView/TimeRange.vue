<script setup>
import { computed, ref, watch } from 'vue';
import { formatDate, t } from '../../../i18n/index.js';
import {
  HOUR_MS,
  seekTime,
  timeBounds,
  validateTime,
} from '../../../chatView/timelineModel.js';

const props = defineProps({
  time: { type: Object, default: () => ({ mode: 'live' }) },
  timeline: {
    type: Object,
    default: () => ({ status: 'live-only', layers: [], marks: [] }),
  },
  events: { type: Array, default: () => [] },
  liveOnly: { type: Array, default: () => [] },
});
const emit = defineEmits(['set', 'playback']);
const error = ref(null);
const draft = ref(null);
const heldDomain = ref(null);
const domain = computed(() => heldDomain.value || props.timeline);
const bounds = computed(() => timeBounds(domain.value));
const intervalBounds = computed(
  () =>
    timeBounds({
      startMs: domain.value.intervalStartMs,
      endMs: domain.value.intervalEndMs,
    }) || bounds.value,
);
const ready = computed(() => domain.value.status === 'ready' && bounds.value);
const cursor = computed(
  () => draft.value ?? domain.value.cursorMs ?? domain.value.nowMs,
);
const live = computed(
  () =>
    draft.value === null && (domain.value.live ?? props.time.mode !== 'range'),
);
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fullDate = (ms) =>
  Number.isFinite(ms)
    ? formatDate(ms, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';
const readout = computed(() =>
  live.value ? t('Live') : fullDate(cursor.value),
);
const position = (ms) => {
  const span = bounds.value;
  if (!span || span.end === span.start) return 0;
  return Math.min(
    100,
    Math.max(0, ((ms - span.start) / (span.end - span.start)) * 100),
  );
};
const marks = computed(() => {
  if (!bounds.value) return [];
  const { start, end } = bounds.value;
  return [
    ...new Set([
      ...(domain.value.marks || []),
      ...props.events.map((event) => event.t),
    ]),
  ]
    .filter((time) => Number.isFinite(time) && time >= start && time <= end)
    .sort((a, b) => a - b);
});
const selected = computed(() => {
  if (!bounds.value) return null;
  const interval = domain.value.interval;
  return (
    interval || {
      fromMs: intervalBounds.value.start,
      toMs: intervalBounds.value.end,
    }
  );
});
const windowLayers = computed(() =>
  (domain.value.layers || []).filter((layer) => layer.kind === 'window'),
);
const presets = computed(() =>
  intervalBounds.value
    ? [1, 6, 24].filter(
        (hours) =>
          hours * HOUR_MS <=
          intervalBounds.value.end - intervalBounds.value.start,
      )
    : [],
);

// A native range owns touch, focus and pointer capture. Dragging previews the
// cursor locally; committing it moves the shared world. A cancelled gesture
// changes no time and never leaves a request in flight.
let pointer = null;
let cancelled = false;
function press(event) {
  if (event.button > 0 || event.isPrimary === false) {
    event.preventDefault();
    return;
  }
  pointer = event.pointerId;
  cancelled = false;
  heldDomain.value = props.timeline;
}
function preview(event) {
  const value = Number(event.target.value);
  if (Number.isFinite(value)) draft.value = value;
}
function clearPreview() {
  draft.value = null;
  heldDomain.value = null;
  pointer = null;
}
function cancel(event) {
  if (
    pointer !== null &&
    event?.pointerId !== undefined &&
    event.pointerId !== pointer
  )
    return;
  cancelled = true;
  clearPreview();
  if (event?.target?.type === 'range')
    event.target.value = props.timeline.cursorMs;
}
function commit(event) {
  if (cancelled || !ready.value) {
    cancelled = false;
    clearPreview();
    return;
  }
  const value = draft.value ?? Number(event.target.value);
  const next = seekTime(props.time, value, domain.value);
  clearPreview();
  error.value = null;
  emit('set', next, { cursorOnly: true });
}
function key(event) {
  if (!ready.value || event.metaKey || event.ctrlKey || event.altKey) return;
  const { start, end } = bounds.value;
  const step = Math.max(60_000, (end - start) / (event.shiftKey ? 10 : 100));
  const at = cursor.value;
  let target;
  if (event.key === 'Home') target = start;
  else if (event.key === 'End') target = end;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown')
    target = marks.value.findLast((mark) => mark < at) ?? at - step;
  else if (event.key === 'ArrowRight' || event.key === 'ArrowUp')
    target = marks.value.find((mark) => mark > at) ?? at + step;
  else if (event.key === 'PageDown') target = at - (end - start) / 10;
  else if (event.key === 'PageUp') target = at + (end - start) / 10;
  else return;
  event.preventDefault();
  cancelled = false;
  error.value = null;
  emit(
    'set',
    seekTime(props.time, Math.max(start, Math.min(end, target)), domain.value),
    { cursorOnly: true },
  );
}
const localValue = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
};
function setIntervalFromInput(endpoint, event) {
  const value = Date.parse(event.target.value);
  const current = selected.value;
  if (!current || !Number.isFinite(value)) {
    error.value = t('Choose a valid date and time.');
    return;
  }
  const interval = { ...current, [endpoint]: value };
  if (interval.fromMs > interval.toMs) {
    error.value = t('The start must be before the end.');
    return;
  }
  const checked = validateTime(
    {
      mode: 'range',
      ...interval,
      cursorMs: cursor.value,
      ...(live.value ? { cursorLive: true } : {}),
    },
    { bounds: domain.value, now: domain.value.nowMs, strict: true },
  );
  // Date fields show minutes. An older untouched endpoint can age out while
  // the user edits the other, and a displayed limit can include seconds.
  if (
    checked.rejected ||
    Math.floor(checked.time[endpoint] / 60_000) !== Math.floor(value / 60_000)
  ) {
    error.value = t('Choose a period inside the available data.');
    return;
  }
  error.value = null;
  emit('set', checked.time);
}
function preset(hours) {
  error.value = null;
  if (hours === null) {
    emit('set', {
      mode: 'range',
      fromMs: intervalBounds.value.start,
      toMs: intervalBounds.value.end,
      cursorMs: cursor.value,
      ...(live.value ? { cursorLive: true } : {}),
    });
    return;
  }
  const checked = validateTime(
    { mode: 'recent', hours },
    { bounds: domain.value, now: domain.value.nowMs },
  );
  if (!live.value && checked.time.mode === 'recent') {
    emit('set', {
      mode: 'range',
      fromMs: domain.value.nowMs - checked.time.hours * HOUR_MS,
      toMs: domain.value.nowMs,
      cursorMs: cursor.value,
    });
  } else emit('set', checked.time);
}
function goLive() {
  cancelled = false;
  clearPreview();
  error.value = null;
  emit('set', { mode: 'live' });
}
watch(
  () => (props.timeline.layers || []).map((layer) => layer.id).join(','),
  () => {
    clearPreview();
    error.value = null;
  },
);
</script>

<template>
  <section
    id="cv-time"
    class="cv-time cv-glass cv-live cv-timeline"
    :aria-label="t('Time')"
  >
    <div class="cv-time-heading">
      <span>{{ t('World time') }}</span>
      <time
        class="cv-time-readout"
        :datetime="
          Number.isFinite(cursor) ? new Date(cursor).toISOString() : undefined
        "
        >{{ readout }}</time
      >
      <button
        class="cv-golive"
        :class="{ on: live }"
        type="button"
        :disabled="time.mode === 'live' && draft === null"
        :aria-label="t('Go live')"
        @click="goLive"
        ><i aria-hidden="true"></i>{{ t('Live') }}</button
      >
    </div>
    <template v-if="ready">
      <div class="cv-track cv-time-track">
        <div
          v-if="selected && !live"
          class="cv-time-range-bar"
          :style="{
            left: `${position(selected.fromMs)}%`,
            width: `${position(selected.toMs) - position(selected.fromMs)}%`,
          }"
          aria-hidden="true"
        ></div>
        <span
          v-for="mark in marks"
          :key="mark"
          class="ev"
          :style="{ left: `${position(mark)}%` }"
          aria-hidden="true"
        ></span>
        <input
          class="cv-time-scrub"
          type="range"
          :min="bounds.start"
          :max="bounds.end"
          step="any"
          :value="cursor"
          :disabled="bounds.end <= bounds.start"
          :aria-label="t('World time')"
          :aria-valuetext="`${fullDate(cursor)} · ${timezone}`"
          @pointerdown="press"
          @pointercancel="cancel"
          @input="preview"
          @change="commit"
          @keydown="key"
          @blur="cancel"
        />
      </div>
      <details class="cv-time-details">
        <summary>
          <span class="cv-time-endpoint">
            <span v-if="windowLayers.length">{{ t('From') }}</span>
            {{ fullDate(windowLayers.length ? selected.fromMs : bounds.start) }}
          </span>
          <b>{{ windowLayers.length ? t('Event period') : t('Details') }}</b>
          <span class="cv-time-endpoint">
            <span v-if="windowLayers.length">{{ t('To') }}</span>
            {{ fullDate(windowLayers.length ? selected.toMs : bounds.end) }}
          </span>
        </summary>
        <div class="cv-time-options">
          <fieldset
            v-if="windowLayers.length"
            class="cv-time-window"
            :aria-label="t('Event period')"
          >
            <div class="cv-time-fields">
              <label
                >{{ t('From')
                }}<input
                  type="datetime-local"
                  :value="localValue(selected.fromMs)"
                  :min="localValue(intervalBounds.start)"
                  :max="localValue(intervalBounds.end)"
                  :aria-invalid="Boolean(error)"
                  @change="setIntervalFromInput('fromMs', $event)"
              /></label>
              <label
                >{{ t('To')
                }}<input
                  type="datetime-local"
                  :value="localValue(selected.toMs)"
                  :min="localValue(intervalBounds.start)"
                  :max="localValue(intervalBounds.end)"
                  :aria-invalid="Boolean(error)"
                  @change="setIntervalFromInput('toMs', $event)"
              /></label>
            </div>
            <div class="cv-time-presets">
              <button
                v-for="hours in presets"
                :key="hours"
                type="button"
                @click="preset(hours)"
                >{{ t('Last {count} h', { count: hours }) }}</button
              >
              <button type="button" @click="preset(null)">{{
                t('All available')
              }}</button>
            </div>
            <p>{{
              t(
                'The period filters events. The slider moves the world independently.',
              )
            }}</p>
          </fieldset>
          <div v-if="domain.playback" class="cv-time-playback">
            <button
              type="button"
              :aria-label="domain.playing ? t('Pause') : t('Play')"
              @click="emit('playback', domain.playing ? 'pause' : 'play')"
              >{{ domain.playing ? t('Pause') : t('Play') }}</button
            >
            <label
              >{{ t('Play speed')
              }}<select
                :value="domain.rate || 1"
                @change="emit('playback', 'rate', Number($event.target.value))"
                ><option :value="1">1×</option
                ><option :value="60">{{ t('1 min/s') }}</option
                ><option :value="3600">{{ t('1 h/s') }}</option
                ><option :value="86400">{{ t('1 d/s') }}</option></select
              ></label
            >
          </div>
          <p class="cv-time-zone">{{
            t('Times shown in {zone}', { zone: timezone })
          }}</p>
          <ul class="cv-time-coverage">
            <li v-for="layer in domain.layers" :key="layer.id"
              ><b>{{ layer.label }}</b
              ><span v-if="layer.status === 'ready'"
                >{{ fullDate(layer.startMs) }} – {{ fullDate(layer.endMs)
                }}<small
                  v-if="
                    !live && (cursor < layer.startMs || cursor > layer.endMs)
                  "
                  >{{ t('No data at the selected time') }}</small
                ></span
              ><span v-else>{{
                layer.status === 'loading'
                  ? t('Loading time coverage')
                  : t('Live only')
              }}</span></li
            >
          </ul>
        </div>
      </details>
    </template>
    <p v-else class="cv-time-empty">{{
      domain.status === 'unavailable'
        ? t(
            'These event sources have no shared period. Explore them separately.',
          )
        : domain.status === 'loading'
          ? domain.layers?.length
            ? t('Loading time coverage')
            : t('Enable a layer with time data to explore its history.')
          : t('These layers show live data only.')
    }}</p>
    <p v-if="error || domain.notice" class="cv-time-note" role="status">{{
      error || domain.notice
    }}</p>
  </section>
</template>
