<script setup>
import { formatNumber, t } from '../../../i18n/index.js';
import { computed, nextTick, onBeforeUpdate, onUpdated, ref, watch } from 'vue';
import { cockpitEntryFace } from '../../cockpitPresentation.js';
import { vFocusSafeChildren } from '../../rail/focusSafeChildren.js';

// What desktop shows beside the globe, as cards over the answer: the
// object you tapped (its context panel), the camera you are watching (its
// CCTV viewer), and the cockpit's steps. One card at a time, most direct
// first.
const props = defineProps({
  focus: { type: Object, default: null },
  stage: { type: Object, default: null },
});
const emit = defineEmits(['follow', 'ask', 'camera', 'cockpit', 'immersion']);
const immersion = computed(() => props.stage?.immersion ?? null);
const entry = computed(() => immersion.value?.entry ?? null);
const entryFace = computed(() => cockpitEntryFace(entry.value?.kind));
const controls = computed(() => immersion.value?.controls ?? {});
const immersiveTitle = computed(() =>
  immersion.value?.subjectKind === 'satellite'
    ? t('Satellite orbital view')
    : immersion.value?.subjectKind === 'vessel'
      ? t('Ship bridge view')
      : t('Cockpit'),
);
const exitLabel = computed(() =>
  immersion.value?.subjectKind === 'satellite'
    ? t('Exit orbital view')
    : immersion.value?.subjectKind === 'vessel'
      ? t('Exit bridge view')
      : t('Leave the cockpit'),
);
const hasImmersiveDetails = computed(
  () =>
    controls.value.previous ||
    controls.value.next ||
    immersion.value?.signals.length ||
    immersion.value?.orbital?.look.readout ||
    immersion.value?.orbital?.look.focus ||
    immersion.value?.bridge?.look.readout ||
    immersion.value?.bridge?.contacts.length,
);
const entryButton = ref(null);
const exitButton = ref(null);
const immersiveCard = ref(null);
let focusedControl = null;
const control = (action, args = {}) =>
  emit('immersion', action, { ...args, subject: immersion.value?.subject });
const enter = () => emit('immersion', 'enter', { ...entry.value });
const leaveSignal = () => exitButton.value?.focus({ preventScroll: true });
onBeforeUpdate(() => {
  const active = document.activeElement;
  focusedControl = immersiveCard.value?.contains(active) ? active : null;
});
onUpdated(() => {
  // A zoom limit, an expired target or a sensor changing under the view
  // must not strand keyboard focus on a disabled or removed control.
  if (
    focusedControl &&
    (!focusedControl.isConnected || focusedControl.disabled)
  )
    leaveSignal();
  focusedControl = null;
});
watch(
  () => immersion.value?.active,
  async (active, before) => {
    if (active === before) return;
    await nextTick();
    (active ? exitButton.value : entryButton.value)?.focus({
      preventScroll: true,
    });
  },
);

const camera = computed(() => props.stage?.camera ?? null);
const cameraSource = computed(() => {
  const { city, provider } = camera.value || {};
  return [...new Set([city, provider].filter(Boolean))].join(' · ');
});
const projectionLabel = computed(() =>
  camera.value?.projecting ? t('PROJECTION ON') : t('PROJECTION OFF'),
);
const card = computed(() => {
  if (immersion.value?.active) return 'immersive';
  if (props.stage?.cockpit) return 'cockpit';
  if (camera.value && props.focus?.layerId === 'cctv') return 'camera';
  if (props.focus?.detail) return 'focus';
  if (entry.value) return 'entry';
  if (camera.value) return 'camera';
  return null;
});
</script>

<template>
  <section
    v-if="card === 'immersive'"
    ref="immersiveCard"
    class="cv-card cv-glass cv-live cv-immersion"
    :aria-label="immersiveTitle"
  >
    <header class="cv-immersion-head">
      <div class="cv-immersion-subject">
        <b class="cv-card-title">{{ immersiveTitle }}</b>
        <p v-if="immersion.subject" class="cv-card-line" dir="auto">{{
          immersion.subject.label
        }}</p>
      </div>
      <details v-if="hasImmersiveDetails" class="cv-immersion-signals">
        <summary class="cv-rchip act" :aria-label="t('Live Signals')">
          {{ t('More') }} <span aria-hidden="true">▾</span>
        </summary>
        <div v-if="controls.previous || controls.next" class="cv-card-acts">
          <button
            class="cv-rchip act"
            type="button"
            :disabled="!controls.previous"
            @click="control('previous')"
            >{{ t('Previous') }}</button
          >
          <button
            class="cv-rchip act"
            type="button"
            :disabled="!controls.next"
            @click="control('next')"
            >{{ t('Next') }}</button
          >
        </div>
        <p v-if="immersion.orbital?.look.readout" class="cv-card-line">{{
          immersion.orbital.look.readout
        }}</p>
        <p
          v-if="immersion.orbital?.look.focus"
          class="cv-card-line"
          dir="auto"
          >{{ immersion.orbital.look.focus.label }}</p
        >
        <p v-if="immersion.bridge?.look.readout" class="cv-card-line">{{
          immersion.bridge.look.readout
        }}</p>
        <ul
          v-if="immersion.bridge?.contacts.length"
          class="cv-card-lines"
          :aria-label="t('Bridge radar')"
        >
          <li
            v-for="contact in immersion.bridge.contacts"
            :key="contact.id"
            dir="auto"
          >
            {{ contact.name
            }}<template v-if="contact.distanceNm !== null">
              ·
              {{
                t('{range} NM', {
                  range: formatNumber(contact.distanceNm, {
                    maximumFractionDigits: 1,
                  }),
                })
              }}</template
            ><template v-if="contact.stale"> · {{ t('STALE') }}</template>
          </li>
        </ul>
        <ul v-focus-safe-children="leaveSignal" class="cv-card-lines">
          <li
            v-for="signal in immersion.signals"
            :key="`${signal.key}:${signal.target?.layerId || ''}:${signal.target?.id || ''}`"
            dir="auto"
          >
            <button
              v-if="signal.target"
              class="cv-rchip act"
              type="button"
              :aria-label="signal.target.label"
              @click="control('signal', { key: signal.key, ...signal.target })"
              >{{ signal.title }}</button
            >
            <b v-else>{{ signal.title }}</b>
            <span class="cv-card-line">{{ signal.detail }}</span>
          </li>
        </ul>
      </details>
      <button
        ref="exitButton"
        class="cv-rchip act cv-immersion-exit"
        type="button"
        :aria-label="exitLabel"
        :title="exitLabel"
        @click="control('exit')"
        >×</button
      >
    </header>
    <div
      v-if="controls.look"
      class="cv-immersion-look"
      role="group"
      :aria-label="t('Look around')"
    >
      <button
        class="cv-rchip act"
        type="button"
        :aria-label="t('Look left')"
        @click="control('lookLeft')"
        >←</button
      >
      <button
        class="cv-rchip act"
        type="button"
        :aria-label="t('Look up')"
        @click="control('lookUp')"
        >↑</button
      >
      <button
        class="cv-rchip act"
        type="button"
        :aria-label="t('Look down')"
        @click="control('lookDown')"
        >↓</button
      >
      <button
        class="cv-rchip act"
        type="button"
        :aria-label="t('Look right')"
        @click="control('lookRight')"
        >→</button
      >
    </div>
    <div class="cv-immersion-actions">
      <template v-if="immersion.orbital">
        <button
          class="cv-rchip act"
          type="button"
          :disabled="!controls.zoomOut"
          :aria-label="t('Zoom out')"
          @click="control('zoomOut')"
          >−</button
        >
        <output>{{ formatNumber(immersion.orbital.zoom) }}×</output>
        <button
          class="cv-rchip act"
          type="button"
          :disabled="!controls.zoomIn"
          :aria-label="t('Zoom in')"
          @click="control('zoomIn')"
          >+</button
        >
        <button
          v-if="controls.sensor"
          class="cv-rchip act"
          type="button"
          :title="immersion.orbital.sensorLabel || undefined"
          :aria-label="t('Zoom to the imaging sensor swath')"
          @click="control('sensor')"
          >{{ t('SENSOR') }}</button
        >
        <button
          v-if="controls.nadir"
          class="cv-rchip act"
          type="button"
          :aria-label="t('Return the view to nadir')"
          @click="control('nadir')"
          >{{ t('NADIR') }}</button
        >
      </template>
      <button
        v-if="immersion.bridge && controls.radar"
        class="cv-rchip act"
        type="button"
        :aria-label="
          t('Radar range {range}. Select for the next range.', {
            range: immersion.bridge.rangeLabel,
          })
        "
        @click="control('radarRange')"
        >{{ t('Bridge radar') }} · {{ immersion.bridge.rangeLabel }}</button
      >
      <button
        v-if="controls.look && immersion.bridge?.look.offset"
        class="cv-rchip act"
        type="button"
        @click="control('lookAhead')"
        >{{ t('LOOK AHEAD') }}</button
      >
    </div>
  </section>
  <section
    v-else-if="card === 'cockpit'"
    class="cv-card cv-glass cv-live"
    :aria-label="t('Cockpit')"
  >
    <b class="cv-card-title">{{ t('Cockpit') }}</b>
    <div class="cv-card-acts">
      <button
        class="cv-rchip act"
        type="button"
        @click="emit('cockpit', 'previous')"
      >
        {{ t('Previous') }}
      </button>
      <button
        class="cv-rchip act"
        type="button"
        @click="emit('cockpit', 'next')"
      >
        {{ t('Next') }}
      </button>
      <button
        class="cv-rchip act"
        type="button"
        @click="emit('cockpit', 'exit')"
      >
        {{ t('Leave the cockpit') }}
      </button>
    </div>
  </section>
  <section
    v-else-if="card === 'focus'"
    class="cv-card cv-glass cv-live"
    :aria-label="focus.detail.title"
  >
    <b class="cv-card-title" dir="auto">{{ focus.detail.title }}</b>
    <p v-if="focus.detail.line" class="cv-card-line" dir="auto">
      {{ focus.detail.line }}
    </p>
    <ul v-if="focus.detail.lines.length" class="cv-card-lines">
      <li v-for="line in focus.detail.lines" :key="line" dir="auto">
        {{ line }}
      </li>
    </ul>
    <div class="cv-card-acts">
      <button
        v-if="entry"
        ref="entryButton"
        class="cv-rchip act cv-immersion-enter"
        type="button"
        :disabled="!entry.enabled"
        :aria-label="entryFace.label"
        @click="enter"
        >{{ entryFace.label }}</button
      >
      <button class="cv-rchip act" type="button" @click="emit('follow')">
        {{ t('Follow') }}
      </button>
      <button class="cv-rchip act" type="button" @click="emit('ask')">
        {{ t('Ask about it') }}
      </button>
    </div>
  </section>
  <section
    v-else-if="card === 'entry'"
    class="cv-card cv-glass cv-live"
    :aria-label="entryFace.label"
  >
    <b class="cv-card-title" dir="auto">{{ entry.label }}</b>
    <div class="cv-card-acts">
      <button
        ref="entryButton"
        class="cv-rchip act cv-immersion-enter"
        type="button"
        :disabled="!entry.enabled"
        :aria-label="entryFace.label"
        @click="enter"
        >{{ entryFace.label }}</button
      >
    </div>
  </section>
  <section
    v-else-if="card === 'camera'"
    class="cv-camera-bar cv-glass cv-live"
    :aria-label="camera.name"
  >
    <div class="cv-camera-description" dir="auto">
      <b class="cv-card-title" :title="camera.name">{{ camera.name }}</b>
      <small v-if="cameraSource" :title="cameraSource">{{
        cameraSource
      }}</small>
    </div>
    <div class="cv-camera-actions">
      <button
        type="button"
        :aria-label="t('Previous')"
        :title="t('Previous')"
        @click="emit('camera', 'prev')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m15 5-7 7 7 7" />
        </svg>
      </button>
      <button
        type="button"
        :aria-label="t('Next')"
        :title="t('Next')"
        @click="emit('camera', 'next')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <button
        type="button"
        :aria-label="t('FOCUS')"
        :title="t('FOCUS')"
        @click="emit('camera', 'focus')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="6" />
          <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
        </svg>
      </button>
      <button
        type="button"
        :aria-label="projectionLabel"
        :title="projectionLabel"
        :aria-pressed="camera.projecting"
        @click="emit('camera', 'projection')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M12 17v4m-4 0h8" />
        </svg>
      </button>
    </div>
    <small
      v-if="camera.status"
      class="cv-camera-status"
      role="status"
      dir="auto"
    >
      {{ camera.status }}
    </small>
  </section>
</template>
