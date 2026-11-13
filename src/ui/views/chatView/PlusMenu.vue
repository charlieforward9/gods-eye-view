<script setup>
import { msg, t } from '../../../i18n/index.js';
import { storeToRefs } from 'pinia';
import { computed, ref } from 'vue';
import { COMMANDS, matchCommands } from '../../../chatView/commands.js';
import { LAYER_CATEGORIES } from '../../../chatView/layers.js';
import { basemapLabel } from '../../../chatView/basemaps.js';
import { STYLE_NAMES, styleLabel } from '../../../chatView/planner.js';
import UiSlider from '../../kit/UiSlider.js';
import UiSelect from '../../kit/UiSelect.js';
import { useDataLibraryStore } from '../../stores/dataLibrary.js';

// Everything the + can do, in three tabs: context to attach, layers to
// plug in (over the map they sit on), and the commands a `/` writes. A
// layer that is on shows desktop's row controls under its row.
const props = defineProps({
  layers: { type: Array, default: () => [] },
  basemap: { type: Object, default: null },
  // The display, scene and camera state desktop's panels show.
  stage: { type: Object, default: null },
  focus: { type: Object, default: null },
  tab: { type: String, default: 'add' },
  slash: { type: String, default: '' },
  provider: { type: Object, default: null },
});
const emit = defineEmits([
  'update:tab',
  'attach',
  'toggle',
  'chip',
  'slider',
  'basemap',
  'look',
  'scene',
  'command',
  'provider',
  'auth',
]);

const filter = ref('');
const { controls: library } = storeToRefs(useDataLibraryStore());
const authOptions = computed(() =>
  (props.provider?.authModes || []).map((value) => ({
    value,
    label: value === 'oauth' ? t('ChatGPT sign-in') : t('API key'),
  })),
);
const on = computed(() => props.layers.filter((row) => row.enabled).length);

const grouped = computed(() => {
  const typed = filter.value.trim().toLowerCase();
  const rows = props.layers.filter(
    (row) => !typed || `${row.label} ${row.name}`.toLowerCase().includes(typed),
  );
  return LAYER_CATEGORIES.map((category) => ({
    ...category,
    rows: rows.filter((row) => row.category === category.id),
  })).filter((category) => category.rows.length);
});

// The first map that can't load here says why, under the picker.
const mapNote = computed(
  () => props.basemap?.options.find((option) => option.reason)?.reason || '',
);

const commands = computed(() =>
  props.slash ? matchCommands(props.slash) : COMMANDS,
);

const formatCount = (count) =>
  count >= 10_000
    ? `${Math.round(count / 1000)}k`
    : count >= 1000
      ? `${(count / 1000).toFixed(1)}k`
      : String(count);

const stateText = (row) => {
  if (row.state === 'connect') return t('Connect');
  if (row.state === 'loading') return t('Loading');
  if (!row.enabled) return '';
  return row.count ? formatCount(row.count) : t('On');
};

// Arrow keys move between the tabs, as a tab list does.
const TABS = ['add', 'layers', 'look', 'commands'];

// Desktop's display switches, in its order. Its HUD is a desktop overlay
// the chat view hides, so it has no switch here.
const SWITCHES = [
  ['detection', msg('Detection')],
  ['bloom', msg('Bloom')],
  ['sharpen', msg('Sharpen')],
];
const moveTab = (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const list = event.currentTarget;
  const rtl = document.documentElement.dir === 'rtl' ? -1 : 1;
  const next =
    TABS[(TABS.indexOf(props.tab) + step * rtl + TABS.length) % TABS.length];
  emit('update:tab', next);
  requestAnimationFrame(() =>
    list.querySelectorAll('[role="tab"]')[TABS.indexOf(next)]?.focus(),
  );
};

const COST = {
  stream: msg('Live stream'),
  view: msg('Follows the view'),
  static: msg('Loads once'),
  poll: msg('Refreshes'),
};
</script>

<template>
  <div
    class="cv-menu cv-glass cv-live"
    role="dialog"
    :aria-label="t('Add to your question')"
  >
    <div class="cv-menu-tabs" role="tablist" @keydown="moveTab">
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'add'"
        aria-controls="cv-menu-panel"
        @click="emit('update:tab', 'add')"
        >{{ t('Add') }}</button
      >
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'layers'"
        aria-controls="cv-menu-panel"
        @click="emit('update:tab', 'layers')"
      >
        {{ t('Layers') }}<span v-if="on" class="cv-count">{{ on }}</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'look'"
        aria-controls="cv-menu-panel"
        @click="emit('update:tab', 'look')"
      >
        {{ t('Look') }}
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'commands'"
        aria-controls="cv-menu-panel"
        @click="emit('update:tab', 'commands')"
        >{{ t('Commands') }}</button
      >
    </div>
    <div id="cv-menu-panel" class="cv-menu-body" role="tabpanel">
      <template v-if="tab === 'add'">
        <button class="cv-item" type="button" @click="emit('attach', 'here')">
          <span class="ic">◎</span><b>{{ t('Here') }}</b
          ><small>{{ t('Your location') }}</small>
        </button>
        <button class="cv-item" type="button" @click="emit('attach', 'view')">
          <span class="ic">▢</span><b>{{ t('This view') }}</b
          ><small>{{ t('What’s on screen right now') }}</small>
        </button>
        <button
          class="cv-item"
          type="button"
          :disabled="!focus"
          @click="emit('attach', 'focus')"
        >
          <span class="ic">✦</span
          ><b>{{ focus ? focus.label : t('Selected object') }}</b
          ><small>{{
            focus
              ? t('What you tapped on the globe')
              : t('Tap something on the globe first')
          }}</small>
        </button>
        <fieldset v-if="provider" class="cv-provider">
          <legend>{{ t('AI Provider') }}</legend>
          <UiSelect
            class="gev-field cv-provider-select"
            :aria-label="t('AI Provider')"
            :options="provider.options"
            :model-value="provider.id"
            @update:model-value="(id) => emit('provider', id)"
          />
          <label v-if="provider.authModes.length > 1" class="cv-provider-auth">
            <span>{{ t('Authentication') }}</span>
            <UiSelect
              class="gev-field cv-auth-select"
              :aria-label="t('Authentication')"
              :options="authOptions"
              :model-value="provider.authMode"
              @update:model-value="(mode) => emit('auth', mode)"
            />
          </label>
          <p
            v-if="provider.status === 'unavailable'"
            class="cv-provider-status"
            role="status"
          >
            {{ provider.detail }}
            {{
              t(
                'Supported commands remain available when the agent is unavailable.',
              )
            }}
          </p>
          <p
            v-else-if="provider.status === 'connecting'"
            class="cv-provider-status"
            role="status"
            >{{ t('Connecting...') }}</p
          >
        </fieldset>
      </template>
      <template v-else-if="tab === 'layers'">
        <button
          v-if="library"
          class="cv-item"
          type="button"
          aria-haspopup="dialog"
          aria-controls="data-library"
          data-library-launcher
          @click="library.open()"
        >
          <b>{{ t('BROWSE DATA LIBRARY') }}</b>
        </button>
        <template v-if="basemap">
          <div class="cv-menu-h">{{ t('Map') }}</div>
          <div
            class="cv-seg cv-basemap"
            role="radiogroup"
            :aria-label="t('Map')"
          >
            <button
              v-for="option in basemap.options"
              :key="option.id"
              type="button"
              role="radio"
              :aria-checked="basemap.active === option.id"
              :disabled="!option.available"
              :title="option.reason || ''"
              @click="emit('basemap', option.id)"
            >
              {{ basemapLabel(option.id) }}
            </button>
          </div>
          <small v-if="mapNote" class="cv-basemap-note">{{ mapNote }}</small>
        </template>
        <input
          v-model="filter"
          class="cv-search"
          type="search"
          :placeholder="t('Search layers')"
          :aria-label="t('Search layers')"
        />
        <template v-for="category in grouped" :key="category.id">
          <div class="cv-menu-h">{{ t(category.label) }}</div>
          <template v-for="row in category.rows" :key="row.id">
            <button
              class="cv-item"
              type="button"
              role="switch"
              :aria-checked="row.enabled"
              @click="emit('toggle', row.id)"
            >
              <span class="ic">{{ row.icon }}</span>
              <b>{{ row.label }}</b>
              <small
                >{{ row.source || row.name }} · {{ t(COST[row.cost]) }}</small
              >
              <span class="side" :class="{ connect: row.state === 'connect' }">
                {{ stateText(row)
                }}<span
                  class="cv-state"
                  :class="row.enabled ? row.state : ''"
                ></span>
              </span>
            </button>
            <div
              v-if="row.controls"
              class="cv-controls"
              role="group"
              :aria-label="t('{layer} settings', { layer: row.label })"
              :data-layer-id="row.id"
            >
              <div v-if="row.controls.chips.length" class="cv-chips">
                <button
                  v-for="chip in row.controls.chips"
                  :key="chip.id"
                  type="button"
                  class="cv-chip"
                  :class="chip.state"
                  :data-chip-id="chip.id"
                  :aria-pressed="chip.active"
                  :aria-busy="chip.busy"
                  :disabled="chip.disabled"
                  :title="chip.title || undefined"
                  @click="emit('chip', row.id, chip.id)"
                >
                  <i
                    v-if="chip.color"
                    class="cv-swatch"
                    :style="{ background: chip.color }"
                  ></i
                  >{{ chip.label }}
                </button>
              </div>
              <template v-if="row.controls.segmented">
                <span v-if="row.controls.segmented.label" class="cv-ctl-h">{{
                  row.controls.segmented.label
                }}</span>
                <div
                  class="cv-seg cv-ctl-seg"
                  role="radiogroup"
                  :aria-label="row.controls.segmented.ariaLabel"
                  :data-segmented-id="row.controls.segmented.id"
                >
                  <button
                    v-for="option in row.controls.segmented.options"
                    :key="option.id"
                    type="button"
                    role="radio"
                    :aria-checked="option.active"
                    :data-chip-id="option.id"
                    :disabled="option.disabled"
                    :title="option.title || undefined"
                    @click="emit('chip', row.id, option.id)"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </template>
              <div
                v-if="row.controls.slider"
                class="cv-ctl-slider"
                :data-slider-id="row.controls.slider.id"
              >
                <span class="cv-ctl-h"
                  >{{ row.controls.slider.label
                  }}<output>{{ row.controls.slider.valueText }}</output></span
                >
                <UiSlider
                  class="cv-range"
                  :min="row.controls.slider.min"
                  :max="row.controls.slider.max"
                  :step="row.controls.slider.step"
                  :model-value="row.controls.slider.value"
                  hold
                  :aria-label="row.controls.slider.ariaLabel || undefined"
                  :aria-valuetext="row.controls.slider.valueText || undefined"
                  :style="
                    row.controls.slider.track
                      ? { '--cv-track': row.controls.slider.track }
                      : undefined
                  "
                  @update:model-value="
                    (value) =>
                      emit('slider', row.id, row.controls.slider.id, value)
                  "
                />
                <div class="cv-ticks" aria-hidden="true">
                  <span
                    v-for="tick in row.controls.slider.ticks"
                    :key="tick.at"
                    :style="{ '--at': `${(tick.at * 100).toFixed(2)}%` }"
                    >{{ tick.label }}</span
                  >
                </div>
              </div>
              <div v-if="row.controls.legend.length" class="cv-legend">
                <span
                  v-for="(entry, index) in row.controls.legend"
                  :key="index"
                  :title="entry.blurb || undefined"
                  ><i class="cv-swatch" :style="{ background: entry.color }"></i
                  >{{ entry.label
                  }}<template v-if="entry.count != null">
                    {{ formatCount(entry.count) }}</template
                  ></span
                >
              </div>
              <p
                v-if="row.controls.info"
                class="cv-ctl-info"
                :title="row.controls.infoTitle || undefined"
              >
                {{ row.controls.info }}
              </p>
            </div>
          </template>
        </template>
      </template>
      <template v-else-if="tab === 'look' && stage">
        <div class="cv-menu-h">{{ t('Style') }}</div>
        <div
          class="cv-seg cv-styles"
          role="radiogroup"
          :aria-label="t('Style')"
        >
          <button
            v-for="name in STYLE_NAMES"
            :key="name"
            type="button"
            role="radio"
            :aria-checked="stage.look.style === name"
            @click="emit('look', 'style', name)"
          >
            {{ styleLabel(name) }}
          </button>
        </div>
        <div class="cv-menu-h">{{ t('Display') }}</div>
        <button
          v-for="[key, label] in SWITCHES"
          :key="key"
          class="cv-item"
          type="button"
          role="switch"
          :aria-checked="stage.look[key]"
          @click="emit('look', key, !stage.look[key])"
        >
          <b>{{ t(label) }}</b>
          <span class="side">
            {{ stage.look[key] ? t('On') : ''
            }}<span
              class="cv-state"
              :class="stage.look[key] ? 'live' : ''"
            ></span>
          </span>
        </button>
        <template v-if="stage.scenes.length">
          <div class="cv-menu-h">{{ t('Scenes') }}</div>
          <button
            v-for="scene in stage.scenes"
            :key="scene.id"
            class="cv-item"
            type="button"
            @click="emit('scene', scene.id)"
          >
            <span class="ic">▶</span><b>{{ t(scene.title) }}</b>
          </button>
          <button class="cv-item" type="button" @click="emit('scene', null)">
            <span class="ic">■</span><b>{{ t('Stop the scene') }}</b>
          </button>
        </template>
      </template>
      <template v-else>
        <button
          v-for="command in commands"
          :key="command.id"
          class="cv-item"
          type="button"
          @click="emit('command', command)"
        >
          <span class="ic cv-slash">/</span>
          <b>{{ t(command.label) }}</b>
          <small>{{ t(command.hint) }}</small>
          <span class="side cv-slash">/{{ command.id }}</span>
        </button>
      </template>
    </div>
  </div>
</template>
