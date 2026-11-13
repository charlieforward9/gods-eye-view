<script setup>
import { t } from '../../../i18n/index.js';

// Where an answer's numbers came from, linked beside them when the
// provider's terms ask for it (Open-Meteo's licence does). Never faded.
defineProps({ sources: { type: Array, default: () => [] } });
</script>

<template>
  <p v-if="sources.length" class="cv-sources">
    <a
      v-for="source in sources"
      :key="source.id"
      :href="source.url"
      target="_blank"
      rel="noopener"
      >{{ t(source.label) }}</a
    >
  </p>
</template>
