/**
 * 翻译API代理模块
 * 整合翻译队列管理，作为翻译函数和后台翻译服务之间的中间层
 */

import { enqueueTranslation, clearTranslationQueue, getQueueStatus } from './translateQueue';
import browser from 'webextension-polyfill';
import { config } from './config';
import { cache } from './cache';
import { detectlang } from './common';
import { storage } from '@wxt-dev/storage';
import { TranslateMessage } from './messageTypes';
import { WordPayload, hasRichWordPayload, isValidWordPayload } from './wordPrompt';

// 调试相关
const isDev = process.env.NODE_ENV === 'development';

/**
 * 翻译参数接口
 */
export interface TranslateOptions {
  /** 最大重试次数 */
  maxRetries?: number;
  /** 重试间隔(毫秒) */
  retryDelay?: number;
  /** 超时时间(毫秒) */
  timeout?: number;
  /** 是否使用缓存 */
  useCache?: boolean;
  /** 翻译模式，默认 sentence；word 模式要求 LLM 返回结构化词典 JSON */
  mode?: 'word' | 'sentence';
  /** word 模式的句子语境，作 prompt context */
  sentence?: string;
}

function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function makeCacheKey(origin: string, mode: 'word' | 'sentence', sentence?: string): string {
  if (mode === 'word') return `inline-word:${djb2Hex(origin + '|' + (sentence ?? ''))}`;
  return origin;
}

// 重载 1：默认 / sentence 模式 → 始终返回 string
export async function translateText(
  origin: string,
  context?: string,
  options?: Omit<TranslateOptions, 'mode'> & { mode?: 'sentence' },
): Promise<string>;
// 重载 2：word 模式 → 返回 string | WordPayload（软降级时为 string）
export async function translateText(
  origin: string,
  context: string | undefined,
  options: Omit<TranslateOptions, 'mode'> & { mode: 'word' },
): Promise<string | WordPayload>;
// 实现
export async function translateText(
  origin: string,
  context: string = document.title,
  options: TranslateOptions = {},
): Promise<string | WordPayload> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    timeout = 45000,
    useCache = config.useCache,
    mode = 'sentence',
    sentence,
  } = options;

  // 如果目标语言与当前文本语言相同，直接返回原文
  if (detectlang(origin.replace(/[\s　]/g, '')) === config.to) {
    return origin;
  }

  const cacheKey = makeCacheKey(origin, mode, sentence);

  // 检查缓存
  if (useCache) {
    const cachedRaw = cache.localGet(cacheKey);
    if (cachedRaw) {
      if (isDev) console.log('[翻译API] 命中缓存，直接返回缓存结果');
      if (mode === 'word') {
        try {
          const parsed = JSON.parse(cachedRaw);
          if (isValidWordPayload(parsed)) return parsed;
        } catch { /* 忽略损坏的缓存项，继续走常规请求 */ }
      } else {
        return cachedRaw;
      }
    }
  }

  // 增加翻译计数
  config.count++;
  // 保存配置以确保计数持久化
  storage.setItem('local:config', JSON.stringify(config));

  // 使用队列处理翻译请求
  return enqueueTranslation(async () => {
    const translationTask = async (retryCount: number = 0): Promise<string | WordPayload> => {
      try {
        const message: TranslateMessage = { context, origin, mode, sentence };
        const result = await Promise.race([
          browser.runtime.sendMessage(message),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('翻译请求超时')), timeout)
          )
        ]) as string | WordPayload;

        if (mode === 'word') {
          // word 模式：只缓存富词典结果；软降级纯译文不缓存，便于下次重新尝试结构化解析。
          if (useCache && isValidWordPayload(result) && hasRichWordPayload(result)) {
            cache.localSet(cacheKey, JSON.stringify(result));
          }
          return result;
        }

        // sentence 模式：保持现行 "结果为空 / 与原文相同 → 返回原文不缓存" 行为
        if (!result || result === origin) return origin;
        if (useCache) cache.localSet(cacheKey, result as string);
        return result;
      } catch (error) {
        if (retryCount < maxRetries) {
          if (isDev) console.log(`[翻译API] 翻译失败，${retryCount + 1}/${maxRetries} 次重试，原因:`, (error as Error).message);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          return translationTask(retryCount + 1);
        }
        throw error;
      }
    };

    return translationTask();
  });
}

/**
 * 当用户离开页面或主动取消翻译时，清空翻译队列
 */
export function cancelAllTranslations() {
  if (isDev) {
    console.log('[翻译API] 取消所有等待中的翻译任务');
  }
  clearTranslationQueue();
}

/**
 * 获取当前翻译队列的状态
 * 可用于UI显示翻译进度等
 */
export function getTranslationStatus() {
  return getQueueStatus();
}
