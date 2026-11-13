<script setup>
import { t, tn } from '../../../i18n/index.js';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { shortTimeLabel, timeLabel } from '../../../chatView/timeWindow.js';

// One input: context chips, the question, and + · Time · Watch · mic · send.
const props = defineProps({
  chips: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  watching: { type: Boolean, default: false },
  time: { type: Object, default: () => ({ mode: 'live' }) },
  timeOpen: { type: Boolean, default: false },
  menuOpen: { type: Boolean, default: false },
  historyCount: { type: Number, default: 0 },
  historyOpen: { type: Boolean, default: false },
});
const emit = defineEmits([
  'focus',
  'send',
  'stop',
  'plus',
  'time',
  'watch',
  'remove-chip',
  'history',
  'slash',
]);

const text = defineModel('text', { type: String, default: '' });
const field = ref(null);
const listening = ref(false);
let recognition = null;

// Time's button reads where the map is in time; a window in the past reads
// as how far back it ends, so the label keeps up with the clock.
const now = ref(Date.now());
const clock = setInterval(() => {
  now.value = Date.now();
}, 60_000);
const live = computed(() => (props.time?.mode ?? 'live') === 'live');
const when = computed(() => timeLabel(props.time, now.value));
// The narrowest phones show the short form; the button's name is the whole.
const whenShort = computed(() => shortTimeLabel(props.time, now.value));

const grow = () => {
  const el = field.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 92)}px`;
};
watch(text, (value) => {
  nextTick(grow);
  emit('slash', /^\/\w*$/.test(value) ? value : '');
});

// Enter only ever sends. The send button turns into Stop while a question
// answers; a second tap just after sending is the same tap, not a stop.
const STOP_AFTER_MS = 600;
let sentAt = 0;
const submit = () => {
  const question = text.value.trim();
  if (!question) return;
  sentAt = Date.now();
  emit('send', question);
  text.value = '';
};
const press = (event) => {
  if (!props.busy || text.value.trim()) return;
  event.preventDefault();
  if (Date.now() - sentAt > STOP_AFTER_MS) emit('stop');
};
const keydown = (event) => {
  // WebKit sends the Enter that confirms a kana or pinyin composition with
  // isComposing false and keyCode 229.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
};

// Dictation fills the field; you read it, then send. No key, no server.
const Recognition =
  globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const mic = () => {
  if (!Recognition) return;
  if (listening.value) return recognition?.stop();
  recognition = new Recognition();
  recognition.interimResults = true;
  recognition.lang = globalThis.navigator?.language || 'en-US';
  const before = text.value ? `${text.value.trim()} ` : '';
  recognition.onresult = (event) => {
    text.value =
      before +
      [...event.results].map((result) => result[0].transcript).join('');
  };
  recognition.onend = () => {
    listening.value = false;
    field.value?.focus();
  };
  recognition.onerror = recognition.onend;
  listening.value = true;
  recognition.start();
};
onBeforeUnmount(() => {
  recognition?.abort();
  clearInterval(clock);
});

defineExpose({ focus: () => field.value?.focus() });
</script>

<template>
  <form
    class="cv-composer cv-glass cv-live"
    autocomplete="off"
    @submit.prevent="submit"
  >
    <div v-if="chips.length" class="cv-ctx">
      <button
        v-for="(chip, i) in chips"
        :key="`${chip.kind}:${chip.id ?? chip.label}`"
        class="cv-chip"
        :class="{ cyan: chip.kind !== 'object' }"
        type="button"
        :aria-label="t('Remove {chip}', { chip: chip.label })"
        @click="emit('remove-chip', i)"
      >
        {{ chip.label }}<span aria-hidden="true">×</span>
      </button>
    </div>
    <textarea
      ref="field"
      v-model="text"
      rows="1"
      :placeholder="t('Ask about anywhere, at any time')"
      :aria-label="t('Ask about anywhere, at any time')"
      enterkeyhint="send"
      @keydown="keydown"
      @focus="emit('focus')"
    ></textarea>
    <div class="cv-tools">
      <button
        class="cv-tool plus"
        type="button"
        :aria-label="t('Add context, layers and commands')"
        :aria-expanded="menuOpen"
        @click="emit('plus')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button
        class="cv-tool time"
        type="button"
        aria-controls="cv-time"
        :aria-expanded="timeOpen"
        :aria-label="t('Timeline: {time}', { time: when })"
        :title="t('Timeline: {time}', { time: when })"
        @click="emit('time')"
      >
        <span class="dot" :class="{ past: !live }" aria-hidden="true"></span
        ><span class="cv-time-label">{{ when }}</span
        ><span class="cv-time-label short">{{ whenShort }}</span>
      </button>
      <button
        class="cv-tool"
        type="button"
        :aria-pressed="watching"
        :aria-label="watching ? t('Watching') : t('Watch')"
        @click="emit('watch')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        >
          <path
            d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"
          /></svg
        ><span class="cv-tool-label">{{
          watching ? t('Watching') : t('Watch')
        }}</span>
      </button>
      <span class="cv-spacer"></span>
      <button
        v-if="historyCount"
        class="cv-tool"
        type="button"
        :aria-expanded="historyOpen"
        :aria-label="
          tn(
            historyCount,
            '{count} question in this session',
            '{count} questions in this session',
          )
        "
        @click="emit('history')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 6h16M4 12h10M4 18h7" /></svg
        ><span class="cv-count">{{ historyCount }}</span>
      </button>
      <button
        v-if="Recognition"
        class="cv-tool mic"
        type="button"
        :aria-pressed="listening"
        :aria-label="listening ? t('Stop dictation') : t('Dictate')"
        @click="mic"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        >
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </button>
      <button
        class="cv-send"
        type="submit"
        :disabled="!busy && !text.trim()"
        :aria-label="busy && !text.trim() ? t('Stop') : t('Send')"
        @click="press"
      >
        <svg
          v-if="busy && !text.trim()"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <rect x="7" y="7" width="10" height="10" rx="2" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 19V5M6 11l6-6 6 6" />
        </svg>
      </button>
    </div>
  </form>
</template>
