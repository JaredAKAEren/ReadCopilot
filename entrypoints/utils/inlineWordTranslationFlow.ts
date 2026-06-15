import type { WordPayload } from './wordPrompt';

export type InlineWordTimingStage = 'fast' | 'rich' | 'total';

export interface InlineWordTranslationFlowOptions {
  fastRequest: () => Promise<string>;
  richRequest: () => Promise<string | WordPayload>;
  onFastResult: (text: string) => void;
  onRichResult: (text: string, payload?: WordPayload) => void;
  onTiming?: (stage: InlineWordTimingStage, elapsedMs: number) => void;
  now?: () => number;
}

export async function runInlineWordTranslationFlow({
  fastRequest,
  richRequest,
  onFastResult,
  onRichResult,
  onTiming,
  now = () => performance.now(),
}: InlineWordTranslationFlowOptions): Promise<void> {
  const start = now();
  let richRendered = false;
  let fastSucceeded = false;
  let richSucceeded = false;
  let fastError: unknown;
  let richError: unknown;

  const emitTiming = (stage: InlineWordTimingStage) => {
    onTiming?.(stage, Math.round(now() - start));
  };

  const fastPromise = fastRequest()
    .then((text) => {
      fastSucceeded = true;
      emitTiming('fast');
      if (!richRendered) {
        onFastResult(text);
      }
    })
    .catch((error) => {
      fastError = error;
    });

  const richPromise = richRequest()
    .then((result) => {
      richSucceeded = true;
      richRendered = true;
      emitTiming('rich');
      if (typeof result === 'string') {
        onRichResult(result);
      } else {
        onRichResult(result.translation, result);
      }
    })
    .catch((error) => {
      richError = error;
    });

  await Promise.all([fastPromise, richPromise]);
  emitTiming('total');

  if (!fastSucceeded && !richSucceeded) {
    throw richError ?? fastError ?? new Error('Inline word translation failed');
  }
}
