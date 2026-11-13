<script setup>
import { msg, t, tn } from '../../../i18n/index.js';
import { computed, ref } from 'vue';
import { LAYER_CATEGORIES } from '../../../chatView/layers.js';

// Sessions grouped by project (yours) or by the layer their answers use.
// It grows out of the pill and folds back into it (see ChatView).
const props = defineProps({
  snapshot: { type: Object, required: true },
});
const emit = defineEmits([
  'close',
  'open-session',
  'new-session',
  'group-by',
  'add-project',
]);

const query = ref('');

const CATEGORY_LABELS = Object.fromEntries(
  LAYER_CATEGORIES.map((category) => [category.id, category.label]),
  // Labels are English data; groups translate them when they render.
);

// Sessions whose questions turn on no layer, and ones with no question yet.
const OTHER_LABELS = { other: msg('Other'), new: msg('Not asked yet') };

const ago = (ms) => {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return t('now');
  if (minutes < 60) return t('{count} min', { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? t('{count} h', { count: hours })
    : t('{count} d', { count: Math.round(hours / 24) });
};

const groups = computed(() => {
  const typed = query.value.trim().toLowerCase();
  const sessions = props.snapshot.sessions.filter(
    (session) => !typed || t(session.title).toLowerCase().includes(typed),
  );
  if (props.snapshot.groupBy === 'layers') {
    const order = [
      ...LAYER_CATEGORIES.map((category) => category.id),
      'other',
      'new',
    ];
    return order
      .map((id) => ({
        id,
        label: t(CATEGORY_LABELS[id] || OTHER_LABELS[id]),
        sessions: sessions.filter((session) => session.category === id),
      }))
      .filter((group) => group.sessions.length);
  }
  const projects = props.snapshot.projects.map((project) => ({
    id: project.id,
    label: t(project.name),
    sessions: sessions.filter((session) => session.projectId === project.id),
  }));
  const loose = sessions.filter(
    (session) =>
      !props.snapshot.projects.some(
        (project) => project.id === session.projectId,
      ),
  );
  return [
    ...(loose.length
      ? [{ id: 'recent', label: t('Recent'), sessions: loose }]
      : []),
    ...projects,
  ];
});

const newProject = () => {
  const name = globalThis.prompt?.(t('Name the project'));
  if (name?.trim()) emit('add-project', name.trim());
};

// Tab stays inside the open drawer.
function trap(event) {
  const panel = event.currentTarget.querySelector('.cv-panel');
  const stops = [
    ...(panel?.querySelectorAll('button:not([disabled]), input') ?? []),
  ];
  if (!stops.length) return;
  const first = stops[0];
  const last = stops.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (!panel.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <!-- Esc closes it through the page's own key handler. -->
  <div
    class="cv-drawer"
    role="dialog"
    aria-modal="true"
    :aria-label="t('Sessions')"
    @keydown.tab="trap"
  >
    <button
      class="cv-scrim"
      type="button"
      :aria-label="t('Close sessions')"
      @click="emit('close')"
    ></button>
    <nav class="cv-panel" :aria-label="t('Sessions')">
      <div class="cv-panel-head">
        <span class="cv-brand" translate="no">GOD'S EYE VIEW</span>
        <button
          class="cv-icon-btn"
          type="button"
          :aria-label="t('Collapse to the pill')"
          @click="emit('close')"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>
      <button class="cv-new" type="button" @click="emit('new-session')">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        {{ t('New session') }}
      </button>
      <div class="cv-seg" role="group" :aria-label="t('Group sessions by')">
        <button
          type="button"
          :aria-pressed="snapshot.groupBy === 'projects'"
          @click="emit('group-by', 'projects')"
          >{{ t('Projects') }}</button
        >
        <button
          type="button"
          :aria-pressed="snapshot.groupBy === 'layers'"
          @click="emit('group-by', 'layers')"
          >{{ t('Layers') }}</button
        >
      </div>
      <div class="cv-groups">
        <input
          v-model="query"
          class="cv-search"
          type="search"
          :placeholder="t('Search sessions')"
          :aria-label="t('Search sessions')"
        />
        <section v-for="group in groups" :key="group.id" class="cv-group">
          <h5>{{ group.label }}</h5>
          <p v-if="!group.sessions.length" class="cv-empty">
            {{ t('No sessions yet') }}
          </p>
          <button
            v-for="session in group.sessions"
            :key="session.id"
            class="cv-sess"
            type="button"
            :aria-current="session.id === snapshot.activeId"
            @click="emit('open-session', session.id)"
          >
            <b>{{ t(session.title) }}</b>
            <small
              >{{
                session.turns
                  ? tn(session.turns, '{count} question', '{count} questions')
                  : t('Not asked yet')
              }}
              · {{ ago(session.updatedAt) }}</small
            >
            <span class="cv-sess-side">
              <span v-if="session.diff.added" class="cv-diff"
                ><span class="add">{{
                  t('+{count} new', { count: session.diff.added })
                }}</span></span
              >
              <span v-if="session.signals" class="cv-sig">{{
                session.signals
              }}</span>
              <span v-else-if="session.watch" class="cv-watching">{{
                t('WATCHING')
              }}</span>
            </span>
          </button>
        </section>
        <button
          v-if="snapshot.groupBy === 'projects'"
          class="cv-sess"
          type="button"
          @click="newProject"
        >
          <small>{{ t('+ New project') }}</small>
        </button>
      </div>
      <div class="cv-foot">{{
        t('Live data. Watched sessions keep checking while you’re elsewhere.')
      }}</div>
    </nav>
  </div>
</template>
