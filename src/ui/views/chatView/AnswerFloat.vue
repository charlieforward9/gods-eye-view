<script setup>
import { t } from '../../../i18n/index.js';
import { computed } from 'vue';
import { SUGGESTIONS } from '../../../chatView/planner.js';
import AnswerSources from './AnswerSources.vue';

// The latest answer, floating on the composer over a fade rather than a
// card: one sentence, then one row of results and actions you can swipe
// through. Before the first question it offers a few to ask.
const props = defineProps({
  turn: { type: Object, default: null },
  busy: { type: Object, default: null },
  playing: { type: Object, default: null },
  views: { type: Number, default: 0 },
});
const emit = defineEmits([
  'suggest',
  'pick',
  'follow',
  'mark',
  'play',
  'history',
  'reset',
]);

// The kernel's busy state, not the turn's saved status: a turn saved
// mid-answer before a reload is not working.
const working = computed(
  () => Boolean(props.turn) && props.busy?.turnId === props.turn.id,
);
const answer = computed(() => props.turn?.answer ?? null);
const rows = computed(() => answer.value?.rows ?? []);
const canFollow = computed(() => rows.value.some((row) => row.followId));
</script>

<template>
  <section class="cv-float cv-live">
    <div
      v-if="!turn"
      class="cv-chips cv-suggestions"
      role="group"
      :aria-label="t('Try asking')"
    >
      <button
        v-for="text in SUGGESTIONS"
        :key="text"
        class="cv-rchip ghost"
        type="button"
        @click="emit('suggest', text)"
      >
        {{ text }}
      </button>
    </div>
    <template v-else>
      <button
        class="cv-float-say"
        type="button"
        :aria-label="t('{question}. Show every question', { question: turn.q })"
        @click="emit('history')"
      >
        <span
          class="cv-live-dot"
          :class="{ busy: working, issue: answer && answer.ok === false }"
          aria-hidden="true"
        ></span>
        <!-- Only the sentence is announced; rows refresh every 10 s. -->
        <span class="cv-float-text" aria-live="polite">
          <small dir="auto">{{ turn.q }}</small>
          <span v-if="working">{{ busy?.label || t('Working') }}…</span>
          <span v-else dir="auto">{{ answer?.say }}</span>
          <em v-if="!working && (answer?.issue || answer?.note)" dir="auto">{{
            answer.issue || answer.note
          }}</em>
        </span>
      </button>
      <AnswerSources v-if="!working && answer" :sources="answer.sources" />
      <div
        v-if="!working && answer"
        class="cv-chips"
        role="group"
        :aria-label="t('Results')"
      >
        <button
          v-for="row in rows"
          :key="row.id"
          class="cv-rchip"
          :class="{ alert: row.alert }"
          type="button"
          dir="auto"
          :title="row.meta"
          @click="emit('pick', row)"
        >
          <span class="n">{{ row.n }}</span
          >{{ row.title
          }}<small v-if="row.meta">{{ row.meta.split(' · ')[0] }}</small>
        </button>
        <button
          v-if="canFollow"
          class="cv-rchip act"
          type="button"
          @click="emit('follow')"
        >
          {{ t('Follow #{n}', { n: 1 }) }}
        </button>
        <button
          v-if="rows.length"
          class="cv-rchip act"
          type="button"
          @click="emit('mark')"
        >
          {{ t('Mark') }}
        </button>
        <button class="cv-rchip act" type="button" @click="emit('reset')">
          {{ t('Reset') }}
        </button>
        <button
          v-if="views > 1"
          class="cv-rchip act"
          type="button"
          :aria-pressed="!!playing"
          @click="emit('play')"
        >
          {{
            playing
              ? t('Playing {index} of {total}', {
                  index: playing.index + 1,
                  total: playing.total,
                })
              : t('Replay')
          }}
        </button>
      </div>
    </template>
  </section>
</template>
