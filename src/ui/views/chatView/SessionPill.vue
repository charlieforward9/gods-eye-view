<script setup>
import { t, tn } from '../../../i18n/index.js';
import { computed } from 'vue';

// The sessions drawer collapsed to one line: the open session, how many
// things its answer holds right now, how many of those are new since you
// last looked, and signals waiting in other sessions.
const props = defineProps({
  session: { type: Object, default: null },
  signals: { type: Number, default: 0 },
  busy: { type: Boolean, default: false },
});
defineEmits(['open']);

const title = computed(() => t(props.session?.title || 'New session'));
const count = computed(
  () => props.session?.turns.at(-1)?.answer?.count ?? null,
);
const fresh = computed(() => props.session?.diff?.added ?? 0);
const short = (n) =>
  n >= 10_000
    ? `${Math.round(n / 1000)}k`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
</script>

<template>
  <button
    class="cv-pill cv-glass cv-live"
    type="button"
    :aria-label="t('Sessions. Open: {title}', { title })"
    @click="$emit('open', $event.currentTarget)"
  >
    <span class="cv-burger" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
      >
        <path d="M4 7h16M4 12h10M4 17h16" />
      </svg>
    </span>
    <span class="cv-live-dot" :class="{ busy }" aria-hidden="true"></span>
    <span class="cv-title">{{ title }}</span>
    <span
      v-if="count !== null"
      class="cv-pill-count"
      :aria-label="
        fresh
          ? t('{count} in the answer, {fresh} new since you looked', {
              count,
              fresh,
            })
          : t('{count} in the answer', { count })
      "
      >{{ short(count)
      }}<b v-if="fresh">{{ t('+{count} new', { count: fresh }) }}</b></span
    >
    <span
      v-if="signals"
      class="cv-sig"
      :aria-label="
        tn(
          signals,
          '{count} signal in other sessions',
          '{count} signals in other sessions',
        )
      "
      >{{ signals }}</span
    >
  </button>
</template>
