<template>
  <teleport to="body">
    <div
      ref="popoverRef"
      class="fr-word-popover"
      :class="{ 'fr-dark-theme': isDarkTheme }"
      @mouseenter="emit('hoverEnter')"
      @mouseleave="emit('hoverLeave')"
    >
      <div class="fr-word-popover-header">
        <span class="fr-word-popover-word">{{ word }}</span>
        <span v-if="payload.ipa" class="fr-word-popover-ipa">{{ payload.ipa }}</span>
        <div v-if="payload.pronunciation" class="fr-word-popover-pronunciation">
          {{ payload.pronunciation }}
        </div>
      </div>

      <div v-if="payload.contextualMeaning" class="fr-word-popover-context">
        <div class="fr-word-popover-context-label">在该语境下</div>
        <div class="fr-word-popover-context-text">{{ payload.contextualMeaning }}</div>
      </div>

      <div v-if="payload.definitions?.length" class="fr-word-popover-section">
        <div class="fr-word-popover-defs-label">完整释义</div>
        <ul class="fr-word-popover-defs">
          <li v-for="(def, i) in payload.definitions" :key="i">
            <span class="fr-word-popover-pos">{{ def.pos }}</span>
            <span class="fr-word-popover-meaning">{{ def.meaning }}</span>
          </li>
        </ul>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, useTemplateRef } from 'vue';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { config } from '@/entrypoints/utils/config';
import type { WordPayload } from '@/entrypoints/utils/wordPrompt';

const props = defineProps<{
  word: string;
  payload: WordPayload;
  referenceEl: HTMLElement;
}>();

const emit = defineEmits<{
  (e: 'hoverEnter'): void;
  (e: 'hoverLeave'): void;
}>();

const popoverRef = useTemplateRef<HTMLElement>('popoverRef');
const isDarkTheme = ref(false);

let cleanupAutoUpdate: (() => void) | null = null;
let stopThemeWatch: (() => void) | null = null;

function updateTheme() {
  const t = config.theme || 'auto';
  if (t === 'auto') {
    isDarkTheme.value = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } else {
    isDarkTheme.value = t === 'dark';
  }
}

onMounted(() => {
  updateTheme();
  stopThemeWatch = watch(() => config.theme, updateTheme);

  const popover = popoverRef.value;
  if (!popover) return;

  cleanupAutoUpdate = autoUpdate(props.referenceEl, popover, () => {
    computePosition(props.referenceEl, popover, {
      placement: 'top',
      middleware: [
        offset(8),
        flip({ fallbackPlacements: ['bottom', 'right', 'left'] }),
        shift({ padding: 8 }),
      ],
    }).then(({ x, y }) => {
      Object.assign(popover.style, { left: `${x}px`, top: `${y}px`, position: 'absolute' });
    });
  });
});

onBeforeUnmount(() => {
  stopThemeWatch?.();
  cleanupAutoUpdate?.();
});
</script>

<style scoped>
.fr-word-popover {
  width: 280px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10);
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.55;
  color: #1f2937;
  z-index: 10001;
}

.fr-word-popover-header {
  padding: 10px 14px 8px;
  border-bottom: 1px solid #f3f4f6;
}

.fr-word-popover-word {
  font-size: 15px;
  font-weight: 600;
  color: #111827;
  margin-right: 6px;
}

.fr-word-popover-ipa {
  display: inline-block;
  font-family: "Fira Mono", "SF Mono", monospace;
  font-size: 12px;
  color: #4f8cff;
}

.fr-word-popover-pronunciation {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}

.fr-word-popover-context {
  background: linear-gradient(180deg, rgba(79,140,255,0.08), rgba(79,140,255,0.03));
  border-left: 3px solid #4f8cff;
  padding: 8px 14px;
}

.fr-word-popover-context-label {
  font-size: 11px;
  color: #4f8cff;
  font-weight: 600;
  margin-bottom: 2px;
}

.fr-word-popover-context-text {
  font-size: 13px;
  color: #1f2937;
  font-weight: 500;
}

.fr-word-popover-section {
  padding: 8px 14px;
  border-top: 1px solid #f3f4f6;
}

.fr-word-popover-defs-label {
  font-size: 11px;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}

.fr-word-popover-defs {
  margin: 0;
  padding: 0;
  list-style: none;
}

.fr-word-popover-defs li {
  margin-bottom: 4px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.fr-word-popover-defs li:last-child { margin-bottom: 0; }

.fr-word-popover-pos {
  flex-shrink: 0;
  font-size: 11px;
  color: #6b7280;
  font-style: italic;
  min-width: 28px;
}

.fr-word-popover-meaning {
  color: #1f2937;
}

/* dark mode */
.fr-word-popover.fr-dark-theme {
  background: #1f1f1f;
  border-color: #333;
  color: #ffffff;
}
.fr-word-popover.fr-dark-theme .fr-word-popover-word { color: #ffffff; }
.fr-word-popover.fr-dark-theme .fr-word-popover-header { border-color: #333; }
.fr-word-popover.fr-dark-theme .fr-word-popover-section { border-color: #333; }
.fr-word-popover.fr-dark-theme .fr-word-popover-context-text { color: #ffffff; }
.fr-word-popover.fr-dark-theme .fr-word-popover-meaning { color: #ffffff; }
.fr-word-popover.fr-dark-theme .fr-word-popover-pronunciation { color: #aaa; }
.fr-word-popover.fr-dark-theme .fr-word-popover-defs-label { color: #d1d5db; }
.fr-word-popover.fr-dark-theme .fr-word-popover-pos { color: #d1d5db; }
.fr-word-popover.fr-dark-theme .fr-word-popover-context-label { color: #69c0ff; }
.fr-word-popover.fr-dark-theme .fr-word-popover-ipa { color: #69c0ff; }
</style>
