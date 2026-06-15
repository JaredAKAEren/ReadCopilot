// background <-> content script 间的翻译请求消息契约。
// sentence 模式（默认）行为与现状一致；word 模式新增 sentence 字段作 prompt context。
export interface TranslateMessage {
  context: string;
  origin: string;
  mode?: 'word' | 'sentence';
  sentence?: string;
}
