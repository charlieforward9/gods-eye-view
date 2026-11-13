<script setup>
import { t } from '../../../i18n/index.js';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { storeToRefs } from 'pinia';
import { useChatViewStore } from '../../stores/chatView.js';
import SessionPill from './SessionPill.vue';
import SessionDrawer from './SessionDrawer.vue';
import HistoryOverlay from './HistoryOverlay.vue';
import AnswerFloat from './AnswerFloat.vue';
import TimeRange from './TimeRange.vue';
import StageCards from './StageCards.vue';
import PlusMenu from './PlusMenu.vue';
import Composer from './Composer.vue';

// The whole chat view, map first: the pill (sessions), the latest answer
// floating on one composer, and the questions and sessions you open from
// there to dig in. Everything it shows comes from the kernel's snapshot;
// everything it does is a kernel intent.
const store = useChatViewStore();
const { snapshot, switchable } = storeToRefs(store);

const session = computed(() => snapshot.value?.session ?? null);
const drawerOpen = ref(false);
const historyOpen = ref(false);
const menuOpen = ref(false);
const menuTab = ref('add');
const slash = ref('');
const text = ref('');
const attached = ref([]);
const focusDismissed = ref(null);
const toast = ref('');
const composer = ref(null);
const root = ref(null);
let pillRect = null;
let toastTimer = null;

const say = (message, ms = 2600) => {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = '';
  }, ms);
};
// The app swapped the map by itself: say so, long enough to read.
watch(
  () => snapshot.value?.basemap?.notice,
  (notice, before) => {
    if (notice && notice !== before) say(notice.text, 7000);
  },
);
async function setBasemap(id) {
  const result = await store.act('setBasemap', id);
  if (result && !result.ok && result.error) say(result.error, 5000);
}
async function immersive(action, args) {
  const result = await store.act('immersive', action, args);
  if (result?.ok === false) say(result.error || t('That did not work.'), 5000);
}
async function camera(action) {
  const result = await store.act('camera', action);
  if (result?.ok === false) say(result.error || t('That did not work.'), 5000);
}

const focus = computed(() => {
  const value = snapshot.value?.focus;
  return value && focusDismissed.value !== `${value.layerId}:${value.id}`
    ? value
    : null;
});
const chips = computed(() => [
  ...(focus.value ? [focus.value] : []),
  ...attached.value,
]);
const busy = computed(() => snapshot.value?.busy ?? null);
const latest = computed(() => session.value?.turns.at(-1) ?? null);
const events = computed(() => latest.value?.answer?.events ?? []);
const views = computed(
  () => session.value?.turns.filter((turn) => turn.hasView).length ?? 0,
);

// ---- Drawer: grows out of the pill and folds back into it. ----
const morph = (panel, from, reverse) => {
  if (
    !panel ||
    !from ||
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
    return Promise.resolve();
  const to = panel.getBoundingClientRect();
  const collapsed = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  const frames = [
    { transform: collapsed, opacity: 0.2 },
    { transform: 'none', opacity: 1 },
  ];
  return panel
    .animate(reverse ? frames.reverse() : frames, {
      duration: reverse ? 220 : 300,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'forwards',
    })
    .finished.catch(() => {});
};
const panelEl = () => root.value?.querySelector('.cv-panel');

async function openDrawer(pill) {
  pillRect = pill?.getBoundingClientRect?.() ?? pillRect;
  menuOpen.value = false;
  drawerOpen.value = true;
  store.act('markSeen');
  await nextTick();
  morph(panelEl(), pillRect, false);
  // The drawer is a dialog: focus moves in, and back to the pill after.
  panelEl()?.querySelector('button')?.focus({ preventScroll: true });
}
let closing = false;
async function closeDrawer() {
  if (!drawerOpen.value || closing) return;
  closing = true;
  await morph(panelEl(), pillRect, true);
  drawerOpen.value = false;
  closing = false;
  await nextTick();
  root.value?.querySelector('.cv-pill')?.focus({ preventScroll: true });
}
function openSession(id) {
  closeDrawer();
  historyOpen.value = false;
  store.act('openSession', id);
}
function newSession() {
  closeDrawer();
  historyOpen.value = false;
  store.act('newSession');
  nextTick(() => composer.value?.focus());
}

// ---- Asking ----
function send(question) {
  const sent = chips.value.map((chip) => ({ ...chip }));
  attached.value = [];
  focusDismissed.value = null;
  menuOpen.value = false;
  historyOpen.value = false;
  store.act('ask', question, sent);
}
function suggest(question) {
  send(question);
}
function removeChip(index) {
  const chip = chips.value[index];
  if (chip === focus.value) {
    focusDismissed.value = `${chip.layerId}:${chip.id}`;
    return;
  }
  attached.value = attached.value.filter((entry) => entry !== chip);
}
async function attach(kind) {
  menuOpen.value = false;
  if (kind === 'focus') return;
  const add = (chip) => {
    attached.value = [
      ...attached.value.filter((entry) => entry.kind !== chip.kind),
      chip,
    ];
  };
  if (kind === 'view') {
    const chip = await store.act('viewChip');
    if (chip) add(chip);
    return;
  }
  const here = await store.act('hereChip');
  if (here) add(here);
  else {
    const chip = await store.act('viewChip');
    if (chip) add(chip);
    say(t('Location is unavailable here, so this view is attached instead'));
  }
  composer.value?.focus();
}
function command(entry) {
  menuOpen.value = false;
  slash.value = '';
  text.value = `/${entry.id} `;
  nextTick(() => composer.value?.focus());
}
function onSlash(prefix) {
  slash.value = prefix;
  if (prefix) {
    menuTab.value = 'commands';
    menuOpen.value = true;
  } else if (
    menuTab.value === 'commands' &&
    menuOpen.value &&
    !text.value.startsWith('/')
  ) {
    menuOpen.value = false;
  }
}
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value && menuTab.value === 'commands' && !slash.value)
    menuTab.value = 'add';
}

// ---- Answers ----
// Picking a row puts it on screen, so the questions fold out of its way.
function pick(row) {
  historyOpen.value = false;
  store.act('pickRow', row);
}
function followFirst() {
  const row = session.value?.turns
    .at(-1)
    ?.answer?.rows?.find((entry) => entry.followId);
  if (row) pick(row);
}
function markRows() {
  store.act('ask', 'mark them', []);
}
function toggleWatch() {
  // A watch keeps an eye on an answer; with none yet there is nothing to watch.
  if (!session.value?.turns?.length)
    return say(t('Ask a question first, then watch its answer.'));
  store.act('toggleWatch');
  say(
    session.value?.watch
      ? t('Stopped watching')
      : t('Watching: you’ll get a signal when this changes'),
  );
}

// ---- Timeline: opened from its button in the composer. ----
// It comes out by itself when the map moves into the past (a question about
// last night) and tucks away again once time is live.
const timeOpen = ref(false);
const timeVisible = computed(
  () => timeOpen.value && !menuOpen.value && !historyOpen.value,
);
const live = computed(() => (session.value?.time?.mode ?? 'live') === 'live');
watch(live, (now) => {
  timeOpen.value = !now;
});
function toggleTime() {
  const open = !timeVisible.value;
  menuOpen.value = false;
  historyOpen.value = false;
  timeOpen.value = open;
}

// The questions open only when asked for; another session starts folded.
watch(
  () => snapshot.value?.activeId,
  () => {
    historyOpen.value = false;
    timeOpen.value = !live.value;
  },
);
function toggleHistory() {
  menuOpen.value = false;
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value) store.act('markSeen');
}

// ---- Map only: the globe is the whole screen, one button brings it back. ----
const mapOnly = computed(() => Boolean(snapshot.value?.mapOnly));
watch(mapOnly, (on) => {
  if (!on) return;
  menuOpen.value = false;
  historyOpen.value = false;
  closeDrawer();
  document.activeElement?.blur?.();
});

const onGlobePointer = (event) => {
  if (!event.target?.closest?.('#cesiumContainer')) return;
  if (menuOpen.value) menuOpen.value = false;
  else if (historyOpen.value) historyOpen.value = false;
};
const onKey = (event) => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (mapOnly.value) store.act('setMapOnly', false);
  else if (menuOpen.value) menuOpen.value = false;
  else if (drawerOpen.value) closeDrawer();
  else if (historyOpen.value) historyOpen.value = false;
  else if (timeOpen.value) timeOpen.value = false;
};
onMounted(() => {
  document.addEventListener('pointerdown', onGlobePointer, true);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onGlobePointer, true);
  document.removeEventListener('keydown', onKey);
  clearTimeout(toastTimer);
});
</script>

<template>
  <div ref="root" class="cv-root">
    <header class="cv-top">
      <SessionPill
        v-if="!drawerOpen"
        :session="session"
        :signals="snapshot?.signals ?? 0"
        :busy="!!busy"
        @open="openDrawer"
      />
      <button
        v-if="snapshot?.signal && !drawerOpen"
        class="cv-signal cv-glass cv-live"
        type="button"
        @click="openSession(snapshot.signal.sessionId)"
      >
        <i aria-hidden="true"></i
        ><span
          ><b>{{ snapshot.signal.title }}</b> · {{ snapshot.signal.text }}</span
        >
      </button>
    </header>
    <button
      v-if="switchable"
      class="cv-to-panels cv-glass cv-live"
      type="button"
      :aria-label="t('Switch to the panels')"
      :title="t('Switch to the panels')"
      @click="store.switchTo('panels')"
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16M15 4v16" />
      </svg>
    </button>
    <button
      class="cv-map-only cv-glass cv-live"
      type="button"
      :aria-pressed="mapOnly"
      :aria-label="t('Map only')"
      :title="t('Map only (V)')"
      @click="store.act('setMapOnly')"
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path v-if="mapOnly" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        <path v-else d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      </svg>
    </button>

    <div v-if="toast" class="cv-toast cv-glass" role="status">{{ toast }}</div>

    <div
      v-if="snapshot"
      class="cv-bottom"
      :class="{
        'cv-bottom--panel':
          timeVisible ||
          (!menuOpen &&
            !historyOpen &&
            (snapshot.stage?.camera || snapshot.stage?.immersion?.active)),
      }"
    >
      <PlusMenu
        v-if="menuOpen"
        v-model:tab="menuTab"
        :layers="snapshot.layers"
        :basemap="snapshot.basemap"
        :stage="snapshot.stage"
        :focus="focus"
        :provider="snapshot.provider"
        :slash="slash"
        @attach="attach"
        @toggle="(id) => store.act('toggleLayer', id)"
        @chip="(id, chipId) => store.act('pickLayerChip', id, chipId)"
        @slider="
          (id, sliderId, value) =>
            store.act('setLayerSlider', id, sliderId, value)
        "
        @basemap="setBasemap"
        @look="(key, value) => store.act('setLook', key, value)"
        @scene="(id) => store.act('playScene', id)"
        @provider="(id) => store.act('setProvider', id)"
        @auth="(mode) => store.act('setAuthMode', mode)"
        @command="command"
      />
      <HistoryOverlay
        v-else-if="historyOpen"
        :session="session"
        :busy="busy"
        :playing="snapshot.playing"
        @close="historyOpen = false"
        @restore="(id) => store.act('restoreTurn', id)"
        @pick="pick"
      />
      <StageCards
        v-if="!menuOpen && !historyOpen && !timeOpen"
        :focus="snapshot.focus"
        :stage="snapshot.stage"
        @follow="send('Follow it')"
        @ask="composer?.focus()"
        @camera="camera"
        @cockpit="(action) => store.act('cockpit', action)"
        @immersion="immersive"
      />
      <AnswerFloat
        v-if="
          !menuOpen &&
          !historyOpen &&
          !timeOpen &&
          (!snapshot.stage?.camera || latest) &&
          !snapshot.stage?.immersion?.active
        "
        :turn="latest"
        :busy="busy"
        :playing="snapshot.playing"
        :views="views"
        @suggest="suggest"
        @pick="pick"
        @follow="followFirst"
        @mark="markRows"
        @play="snapshot.playing ? store.act('stop') : store.act('play')"
        @history="toggleHistory"
        @reset="send('reset')"
      />
      <TimeRange
        v-if="timeVisible"
        :time="session?.time ?? { mode: 'live' }"
        :events="events"
        :live-only="snapshot.liveOnly"
        :timeline="snapshot.timeline"
        @set="(time, options) => store.act('setTime', time, options)"
        @playback="(action, rate) => store.act('timePlayback', action, rate)"
      />
      <Composer
        ref="composer"
        v-model:text="text"
        :chips="chips"
        :busy="!!busy"
        :watching="!!session?.watch"
        :time="session?.time ?? { mode: 'live' }"
        :time-open="timeVisible"
        :menu-open="menuOpen"
        :history-count="session?.turns.length ?? 0"
        :history-open="historyOpen"
        @focus="store.act('warm')"
        @send="send"
        @stop="store.act('stop')"
        @plus="toggleMenu"
        @time="toggleTime"
        @watch="toggleWatch"
        @remove-chip="removeChip"
        @history="toggleHistory"
        @slash="onSlash"
      />
    </div>

    <SessionDrawer
      v-if="drawerOpen && snapshot"
      :snapshot="snapshot"
      @close="closeDrawer"
      @open-session="openSession"
      @new-session="newSession"
      @group-by="(mode) => store.act('setGroupBy', mode)"
      @add-project="(name) => store.act('addProject', name)"
    />
  </div>
</template>
