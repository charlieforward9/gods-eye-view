<script setup>
import { t } from '../../../i18n/index.js';
import { computed, nextTick, onMounted, ref } from 'vue';
import AnswerSources from './AnswerSources.vue';

// Every question in the session, opened from the answer when you want to dig
// in and folded away by a swipe down, the handle, or a tap on the globe. Each
// answer keeps its view; tapping it puts that view back.
const props = defineProps({
  session: { type: Object, default: null },
  busy: { type: Object, default: null },
  playing: { type: Object, default: null },
});
const emit = defineEmits(['close', 'restore', 'pick']);

const body = ref(null);
const turns = computed(() => props.session?.turns ?? []);
const busyLabel = computed(() => props.busy?.label || t('Working'));
const verbsOf = (turn) => turn.answer?.verbs?.join(' · ') || '';
const clock = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// A drag of 36px or more down folds the sheet; a tap on the handle does too.
let startY = null;
const down = (event) => {
  startY = event.clientY;
};
const up = (event) => {
  if (startY === null) return;
  const dy = event.clientY - startY;
  startY = null;
  if (dy > 36 || Math.abs(dy) < 8) emit('close');
};
// Enter or Space on the handle: a click with no pointer behind it.
const key = (event) => {
  if (event.detail === 0) emit('close');
};

onMounted(async () => {
  await nextTick();
  body.value?.scrollTo({ top: body.value.scrollHeight });
});
</script>

<template>
  <section class="cv-history cv-live" :aria-label="t('Questions')">
    <button
      class="cv-handle"
      type="button"
      :aria-label="t('Fold the questions away')"
      @pointerdown="down"
      @pointerup="up"
      @pointercancel="startY = null"
      @click="key"
    ></button>
    <div ref="body" class="cv-history-body">
      <p v-if="!turns.length" class="cv-empty">{{
        t('No questions in this session yet.')
      }}</p>
      <article v-for="turn in turns" :key="turn.id" class="cv-turn">
        <div class="cv-you">
          <div v-if="turn.chips.length" class="cv-tags">
            <span v-for="chip in turn.chips" :key="chip" class="cv-tag">{{
              chip
            }}</span>
          </div>
          <span dir="auto">{{ turn.q }}</span>
        </div>
        <div
          v-if="busy?.turnId === turn.id && turn.status === 'running'"
          class="cv-working"
        >
          {{ busyLabel }}…
        </div>
        <div
          v-else-if="turn.answer"
          class="cv-answer"
          :class="{ failed: turn.answer.ok === false }"
        >
          <div class="cv-say" dir="auto">{{ turn.answer.say }}</div>
          <div
            v-if="turn.answer.issue || turn.answer.note"
            class="cv-caveat"
            dir="auto"
          >
            {{ turn.answer.issue || turn.answer.note }}
          </div>
          <AnswerSources :sources="turn.answer.sources" />
          <ol v-if="turn.answer.rows?.length" class="cv-rows">
            <li
              v-for="row in turn.answer.rows"
              :key="row.id"
              :class="{ alert: row.alert }"
            >
              <button type="button" @click="emit('pick', row)">
                <span class="n">{{ row.n }}</span>
                <span class="t" dir="auto">{{ row.title }}</span>
                <span class="s">{{ row.meta }}</span>
              </button>
            </li>
          </ol>
          <div class="cv-meta">
            <button
              v-if="turn.hasView"
              class="cv-view"
              type="button"
              :aria-current="playing?.turnId === turn.id"
              @click="emit('restore', turn.id)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path
                  d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"
                />
              </svg>
              {{ t('View · {time}', { time: clock(turn.at) }) }}
            </button>
            <span v-if="verbsOf(turn)" class="cv-verbs"
              ><b>{{ t('Ran') }}</b> {{ verbsOf(turn) }}</span
            >
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
