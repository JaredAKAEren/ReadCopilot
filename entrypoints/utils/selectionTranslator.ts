import { createApp } from 'vue';
import SelectionTranslator from '@/components/SelectionTranslator.vue';
import { config } from '@/entrypoints/utils/config';
import { storage } from '@wxt-dev/storage';

let selectionTranslatorInstance: any = null;
let app: any = null;
let container: HTMLElement | null = null;
let containerObserver: MutationObserver | null = null;
let restoreTimer: number | null = null;
let shouldKeepMounted = false;

const CONTAINER_ID = 'fluent-read-selection-translator-container';

function isMountedInCurrentBody() {
  return Boolean(
    selectionTranslatorInstance &&
    app &&
    container &&
    container.isConnected &&
    container.parentElement === document.body,
  );
}

function mountSelectionTranslatorApp() {
  if (!document.body) return null;

  const existingContainer = document.getElementById(CONTAINER_ID);
  if (existingContainer) {
    existingContainer.remove();
  }

  container = document.createElement('div');
  container.id = CONTAINER_ID;
  document.body.appendChild(container);

  app = createApp(SelectionTranslator);
  selectionTranslatorInstance = app.mount(container);

  return selectionTranslatorInstance;
}

function unmountSelectionTranslatorApp() {
  if (app) {
    app.unmount();
  }

  selectionTranslatorInstance = null;
  app = null;

  if (container?.isConnected) {
    container.remove();
  } else {
    document.getElementById(CONTAINER_ID)?.remove();
  }

  container = null;
}

function restoreSelectionTranslatorIfDetached() {
  if (
    !shouldKeepMounted ||
    config.disableSelectionTranslator ||
    config.selectionTranslatorMode === 'disabled' ||
    isMountedInCurrentBody()
  ) {
    return;
  }

  unmountSelectionTranslatorApp();
  mountSelectionTranslatorApp();
}

function startContainerObserver() {
  if (containerObserver || typeof MutationObserver === 'undefined') return;

  containerObserver = new MutationObserver(() => {
    if (restoreTimer !== null) return;

    restoreTimer = window.setTimeout(() => {
      restoreTimer = null;
      restoreSelectionTranslatorIfDetached();
    }, 0);
  });

  containerObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function stopContainerObserver() {
  if (restoreTimer !== null) {
    window.clearTimeout(restoreTimer);
    restoreTimer = null;
  }

  containerObserver?.disconnect();
  containerObserver = null;
}

/**
 * 挂载选词翻译组件
 */
export function mountSelectionTranslator() {
  // 如果已存在实例或配置禁用了此功能，则不创建
  if (config.disableSelectionTranslator || config.selectionTranslatorMode === 'disabled') {
    return;
  }

  shouldKeepMounted = true;
  startContainerObserver();

  if (isMountedInCurrentBody()) {
    return selectionTranslatorInstance;
  }

  unmountSelectionTranslatorApp();
  return mountSelectionTranslatorApp();
}

/**
 * 卸载选词翻译组件
 */
export function unmountSelectionTranslator() {
  shouldKeepMounted = false;
  stopContainerObserver();
  unmountSelectionTranslatorApp();
}

/**
 * 切换选词翻译组件的启用状态
 */
export function toggleSelectionTranslator() {
  if (selectionTranslatorInstance) {
    unmountSelectionTranslator();
    config.disableSelectionTranslator = true;
  } else {
    config.disableSelectionTranslator = false;
    mountSelectionTranslator();
  }
  
  // 保存配置到存储
  saveConfig();
}

/**
 * 保存配置到存储
 */
function saveConfig() {
  // 使用插件提供的存储API保存配置
  storage.setItem('local:config', JSON.stringify(config)).catch((error) => {
    console.error('Failed to save config:', error);
  });
}
