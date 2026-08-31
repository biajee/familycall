import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockTranscriber } from '../server/stt/mock.js';
import { OpenAITranscriber, openaiLanguages } from '../server/stt/openai.js';
import { DeepgramTranscriber, deepgramLanguage } from '../server/stt/deepgram.js';
import { providerInfo } from '../server/stt/index.js';

test('mock transcriber emits interim then final captions from audio volume', () => {
  const events = [];
  const tx = new MockTranscriber({ lang: 'zh-CN', onText: (e) => events.push(e), onStatus() {} }).start();
  const chunk = Buffer.alloc(3200); // 100 ms @ 16 kHz int16
  for (let i = 0; i < 20; i++) tx.write(chunk);
  assert.equal(events.length, 2);
  assert.equal(events[0].final, false);
  assert.equal(events[1].final, true);
  assert.equal(events[0].key, events[1].key);
  assert.match(events[1].text, /测试字幕 1。$/);
  tx.close();
});

test('openai session config uses the transcription session shape', () => {
  const cfg = {
    sttPrompt: 'family call',
    openai: { apiKey: 'k', url: 'wss://x', model: 'gpt-live-transcribe', delay: 'low', noiseReduction: 'near_field' },
  };
  const tx = new OpenAITranscriber({ lang: 'auto', cfg, onText() {}, onStatus() {} });
  const s = tx._sessionConfig();
  assert.equal(s.type, 'session.update');
  assert.equal(s.session.type, 'transcription');
  assert.deepEqual(s.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.deepEqual(s.session.audio.input.transcription.languages, ['zh-cn', 'en']);
  assert.equal(s.session.audio.input.transcription.prompt, 'family call');
  assert.equal(s.session.audio.input.turn_detection, undefined, 'gpt-live models reject turn_detection');
  assert.deepEqual(openaiLanguages('zh-CN'), ['zh-cn']);
  assert.deepEqual(openaiLanguages('en-US'), ['en']);

  const legacyCfg = { ...cfg, openai: { ...cfg.openai, model: 'gpt-4o-transcribe' } };
  const legacy = new OpenAITranscriber({ lang: 'en-US', cfg: legacyCfg, onText() {}, onStatus() {} });
  const li = legacy._sessionConfig().session.audio.input;
  assert.equal(li.transcription.language, 'en');
  assert.equal(li.transcription.languages, undefined);
  assert.equal(li.turn_detection.type, 'server_vad');
});

test('openai events accumulate deltas per item and finalize', () => {
  const events = [];
  const cfg = { sttPrompt: '', openai: { apiKey: 'k', url: 'wss://x', model: 'gpt-live-transcribe', delay: 'low' } };
  const tx = new OpenAITranscriber({ lang: 'en-US', cfg, onText: (e) => events.push(e), onStatus() {} });
  tx._onMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Hello' });
  tx._onMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: ' there' });
  tx._onMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Hello there.' });
  assert.deepEqual(events, [
    { key: 'i1', text: 'Hello', final: false },
    { key: 'i1', text: 'Hello there', final: false },
    { key: 'i1', text: 'Hello there.', final: true },
  ]);
});

test('deepgram results are merged into utterances', () => {
  const events = [];
  const cfg = { deepgram: { apiKey: 'k', url: 'wss://x', model: 'nova-3' } };
  const tx = new DeepgramTranscriber({ lang: 'en-US', cfg, onText: (e) => events.push(e), onStatus() {} });
  const results = (transcript, is_final, speech_final) => ({
    type: 'Results', is_final, speech_final, channel: { alternatives: [{ transcript }] },
  });
  tx._onMessage(results('how are', false, false));
  tx._onMessage(results('how are you', true, false));
  tx._onMessage(results('today', false, false));
  tx._onMessage(results('today?', true, true));
  tx._onMessage(results('fine', false, false));
  tx._onMessage({ type: 'UtteranceEnd' }); // nothing finalized yet -> no final event
  tx._onMessage(results('fine.', true, false));
  tx._onMessage({ type: 'UtteranceEnd' });
  assert.deepEqual(events, [
    { key: 'u0', text: 'how are', final: false },
    { key: 'u0', text: 'how are you', final: false },
    { key: 'u0', text: 'how are you today', final: false },
    { key: 'u0', text: 'how are you today?', final: true },
    { key: 'u1', text: 'fine', final: false },
    { key: 'u1', text: 'fine.', final: false },
    { key: 'u1', text: 'fine.', final: true },
  ]);
  assert.equal(deepgramLanguage('auto'), 'zh-CN');
  assert.equal(deepgramLanguage('en-US'), 'en-US');

  const zh = new DeepgramTranscriber({ lang: 'zh-CN', cfg, onText: (e) => events.push(e), onStatus() {} });
  events.length = 0;
  zh._onMessage(results('你好', true, false));
  zh._onMessage(results('爸爸', true, true));
  assert.equal(events.at(-1).text, '你好爸爸', 'Chinese segments are joined without spaces');
});

test('providerInfo reports audio rate and auto-language support', () => {
  assert.deepEqual(providerInfo({ sttProvider: 'openai' }), { name: 'openai', audioRate: 24000, autoLang: true });
  assert.deepEqual(providerInfo({ sttProvider: 'deepgram' }), { name: 'deepgram', audioRate: 16000, autoLang: false });
  assert.deepEqual(providerInfo({ sttProvider: 'mock' }), { name: 'mock', audioRate: 16000, autoLang: true });
  assert.throws(() => providerInfo({ sttProvider: 'nope' }), /Unknown STT_PROVIDER/);
});
