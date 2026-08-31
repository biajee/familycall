import { MockTranscriber } from './mock.js';
import { OpenAITranscriber } from './openai.js';
import { DeepgramTranscriber } from './deepgram.js';
import { XfyunTranscriber } from './xfyun.js';

const PROVIDERS = { mock: MockTranscriber, openai: OpenAITranscriber, deepgram: DeepgramTranscriber, xfyun: XfyunTranscriber };

export function providerClass(name) {
  const cls = PROVIDERS[name];
  if (!cls) throw new Error(`Unknown STT_PROVIDER "${name}" (expected one of ${Object.keys(PROVIDERS).join(', ')})`);
  return cls;
}

export function providerInfo(cfg, name = cfg.sttProvider) {
  const cls = providerClass(name);
  return { name, audioRate: cls.audioRate, autoLang: cls.autoLang };
}

/** Providers that have credentials configured (selectable per phone from the in-call settings). */
export function availableProviders(cfg) {
  const list = [];
  if (cfg.openai.apiKey) list.push('openai');
  if (cfg.deepgram.apiKey) list.push('deepgram');
  if (cfg.xfyun.appId && cfg.xfyun.apiKey) list.push('xfyun');
  if (list.length === 0 || cfg.sttProvider === 'mock') list.push('mock');
  return list;
}

/** Create and start a transcriber. opts: {lang, onText, onStatus, log} */
export function createTranscriber(cfg, opts, name = cfg.sttProvider) {
  const Cls = providerClass(name);
  return new Cls({ ...opts, cfg }).start();
}
