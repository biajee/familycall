import { MockTranscriber } from './mock.js';
import { OpenAITranscriber } from './openai.js';
import { DeepgramTranscriber } from './deepgram.js';

const PROVIDERS = { mock: MockTranscriber, openai: OpenAITranscriber, deepgram: DeepgramTranscriber };

export function providerClass(name) {
  const cls = PROVIDERS[name];
  if (!cls) throw new Error(`Unknown STT_PROVIDER "${name}" (expected one of ${Object.keys(PROVIDERS).join(', ')})`);
  return cls;
}

export function providerInfo(cfg) {
  const cls = providerClass(cfg.sttProvider);
  return { name: cfg.sttProvider, audioRate: cls.audioRate, autoLang: cls.autoLang };
}

/** Create and start a transcriber. opts: {lang, onText, onStatus, log} */
export function createTranscriber(cfg, opts) {
  const Cls = providerClass(cfg.sttProvider);
  return new Cls({ ...opts, cfg }).start();
}
