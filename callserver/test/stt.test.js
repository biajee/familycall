import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MockTranscriber } from '../server/stt/mock.js';
import { OpenAITranscriber, openaiLanguages } from '../server/stt/openai.js';
import { DeepgramTranscriber, deepgramLanguage } from '../server/stt/deepgram.js';
import { XfyunTranscriber, xfyunSigna, xfyunUrl, xfyunLlmUrl, xfyunUtc, xfyunService } from '../server/stt/xfyun.js';
import { FunasrTranscriber } from '../server/stt/funasr.js';
import { providerInfo, availableProviders } from '../server/stt/index.js';

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

test('openai gpt-live commits the audio buffer to close utterances', () => {
  const sent = [];
  const cfg = { sttPrompt: '', openai: { apiKey: 'k', url: 'wss://x', model: 'gpt-live-transcribe', delay: 'low' } };
  const tx = new OpenAITranscriber({ lang: 'en-US', cfg, onText() {}, onStatus() {} });
  tx.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) }; // 1 === WebSocket.OPEN

  assert.equal(tx._maybeCommit(5000), false, 'no pending utterance yet');
  tx._onMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'hi' });
  tx._pendingSince = 1000; tx._lastDeltaAt = 1000; tx._lastCommitAt = -10000;
  assert.equal(tx._maybeCommit(1800), false, 'still speaking (delta 0.8s ago)');
  assert.equal(tx._maybeCommit(2300), true, 'quiet for 1.3s -> commit');
  assert.deepEqual(sent.at(-1), { type: 'input_audio_buffer.commit' });
  assert.equal(tx._maybeCommit(4000), false, 'nothing pending after commit');

  // continuous speech is force-committed at the max utterance length
  tx._pendingSince = 10_000; tx._lastDeltaAt = 25_500; tx._lastCommitAt = 0;
  assert.equal(tx._maybeCommit(25_600), true, 'utterance over 15s -> forced commit');

  // completed clears the pending state
  tx._pendingSince = 50_000;
  tx._onMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hi.' });
  assert.equal(tx._pendingSince, 0);

  // benign commit-vs-silence race must not flip the status light
  let status;
  const tx2 = new OpenAITranscriber({ lang: 'en-US', cfg, onText() {}, onStatus: (ok) => { status = ok; } });
  tx2._onMessage({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer empty' } });
  assert.equal(status, undefined);
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

test('xfyun RTASR url carries the documented signature', () => {
  // signa = Base64(HmacSHA1(MD5hex(appid + ts), apiKey))
  const md5 = crypto.createHash('md5').update('app1' + '1700000000').digest('hex');
  const expected = crypto.createHmac('sha1', 'key1').update(md5).digest('base64');
  assert.equal(xfyunSigna('app1', 'key1', '1700000000'), expected);

  const cfg = { appId: 'app1', apiKey: 'key1', url: 'wss://rtasr.xfyun.cn/v1/ws' };
  const url = new URL(xfyunUrl(cfg, 'zh-CN', 1700000000 * 1000));
  assert.equal(url.searchParams.get('appid'), 'app1');
  assert.equal(url.searchParams.get('ts'), '1700000000');
  assert.equal(url.searchParams.get('signa'), expected);
  assert.equal(url.searchParams.get('lang'), null, 'default model handles zh with mixed en');
  const en = new URL(xfyunUrl(cfg, 'en-US', 1700000000 * 1000));
  assert.equal(en.searchParams.get('lang'), 'en');
});

test('xfyun 大模型版 url sorts params and signs with the APISecret', () => {
  const cfg = {
    appId: 'app1', apiKey: 'ak1', apiSecret: 'sk1',
    llmUrl: 'wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1',
  };
  assert.equal(xfyunUtc(Date.UTC(2026, 8, 4, 15, 38, 7)), '2026-09-04T15:38:07+0000');

  const url = new URL(xfyunLlmUrl(cfg, 'zh-CN', Date.UTC(2026, 8, 4, 15, 38, 7), 'uuid-1'));
  const q = url.searchParams;
  assert.equal(q.get('accessKeyId'), 'ak1');
  assert.equal(q.get('appId'), 'app1');
  assert.equal(q.get('audio_encode'), 'pcm_s16le');
  assert.equal(q.get('lang'), 'autodialect');
  assert.equal(q.get('samplerate'), '16000');
  assert.equal(q.get('utc'), '2026-09-04T15:38:07+0000');
  // signature = Base64(HmacSHA1(sorted&encoded params, accessKeySecret))
  const base = [...url.search.slice(1).split('&')].filter((kv) => !kv.startsWith('signature=')).join('&');
  const keys = base.split('&').map((kv) => kv.split('=')[0]);
  assert.deepEqual(keys, [...keys].sort(), 'params must be alphabetically sorted');
  const expected = crypto.createHmac('sha1', 'sk1').update(base).digest('base64');
  assert.equal(q.get('signature'), expected);

  assert.equal(xfyunService({ service: 'auto', apiSecret: 'x' }), 'rtasr_llm');
  assert.equal(xfyunService({ service: 'auto', apiSecret: '' }), 'rtasr');
  assert.equal(xfyunService({ service: 'rtasr', apiSecret: 'x' }), 'rtasr');
});

test('xfyun results map to per-utterance interim/final captions', () => {
  const events = [];
  const statuses = [];
  const cfg = { xfyun: { appId: 'a', apiKey: 'k', url: 'wss://x' } };
  const tx = new XfyunTranscriber({ lang: 'zh-CN', cfg, onText: (e) => events.push(e), onStatus: (ok, m) => statuses.push([ok, m]) });

  const result = (type, words) => ({
    action: 'result',
    data: JSON.stringify({ seg_id: 1, cn: { st: { type, rt: [{ ws: words.map((w) => ({ cw: [{ w }] })) }] } } }),
  });
  tx._onMessage({ action: 'started', code: '0' });
  tx._onMessage(result('1', ['你']));
  tx._onMessage(result('1', ['你好', '爸爸']));
  tx._onMessage(result('0', ['你好', '爸爸', '。']));
  tx._onMessage(result('1', ['吃了吗']));
  tx._onMessage({ action: 'error', code: '10800', desc: 'over max connect limit' });
  assert.deepEqual(events, [
    { key: 'u0', text: '你', final: false },
    { key: 'u0', text: '你好爸爸', final: false },
    { key: 'u0', text: '你好爸爸。', final: true },
    { key: 'u1', text: '吃了吗', final: false },
  ]);
  assert.deepEqual(statuses, [[true, 'ok'], [false, 'over max connect limit']]);

  // binary audio is re-framed to RTASR's 1280-byte chunks
  const sent = [];
  tx.ws = { send: (b) => sent.push(b.length) };
  tx._sendAudio(Buffer.alloc(3200));
  assert.deepEqual(sent, [1280, 1280, 640]);

  // 大模型版 envelope: {msg_type, data:{...}} with data as an object
  events.length = 0;
  statuses.length = 0;
  const llm = new XfyunTranscriber({ lang: 'zh-CN', cfg, onText: (e) => events.push(e), onStatus: (ok, m) => statuses.push([ok, m]) });
  llm._onMessage({ msg_type: 'action', data: { action: 'started', sessionId: 'sess-1' } });
  assert.equal(llm.sessionId, 'sess-1');
  const llmResult = (type, words, ls) => ({
    msg_type: 'result',
    res_type: 'asr',
    data: { seg_id: 0, ls, cn: { st: { type, rt: [{ ws: words.map((w) => ({ cw: [{ w }] })) }] } } },
  });
  llm._onMessage(llmResult('1', ['今天'], false));
  llm._onMessage(llmResult('0', ['今天天气好'], true));
  // xfyun sends the previous sentence's punctuation at the START of a later
  // segment; the previous final is re-emitted (amended) with it appended and
  // the mark never shows at the front of a bubble.
  llm._onMessage(llmResult('1', ['明天'], false));
  llm._onMessage(llmResult('0', ['？', '明天', '见'], true));
  assert.deepEqual(events, [
    { key: 'u0', text: '今天', final: false },
    { key: 'u0', text: '今天天气好', final: true },
    { key: 'u1', text: '明天', final: false },
    { key: 'u0', text: '今天天气好？', final: true }, // amendment of the previous bubble
    { key: 'u1', text: '明天见', final: true },
  ]);
  assert.deepEqual(statuses, [[true, 'ok']]);
  llm.close();
});

test('funasr 2pass: online pieces accumulate, offline result finalizes the segment', () => {
  const events = [];
  const sent = [];
  const cfg = { sttHotwords: '{"爸爸":20}', funasr: { url: 'ws://127.0.0.1:10095' } };
  const tx = new FunasrTranscriber({ lang: 'zh-CN', cfg, onText: (e) => events.push(e), onStatus() {} });
  tx.ws = { send: (m) => sent.push(m), readyState: 1 };
  tx._onOpen();
  const hello = JSON.parse(sent[0]);
  assert.equal(hello.mode, '2pass');
  assert.deepEqual(hello.chunk_size, [5, 10, 5]);
  assert.equal(hello.audio_fs, 16000);
  assert.equal(hello.hotwords, '{"爸爸":20}');
  assert.equal(hello.is_speaking, true);

  tx._onMessage({ mode: '2pass-online', text: '你好', is_final: false });
  tx._onMessage({ mode: '2pass-online', text: '爸爸', is_final: false });
  tx._onMessage({ mode: '2pass-offline', text: '你好，爸爸。', is_final: false });
  tx._onMessage({ mode: '2pass-online', text: '吃了吗', is_final: false });
  assert.deepEqual(events, [
    { key: 'u0', text: '你好', final: false },
    { key: 'u0', text: '你好爸爸', final: false },
    { key: 'u0', text: '你好，爸爸。', final: true },
    { key: 'u1', text: '吃了吗', final: false },
  ]);
  tx._beforeClose();
  assert.deepEqual(JSON.parse(sent.at(-1)), { is_speaking: false });
});

test('providerInfo reports audio rate and auto-language support', () => {
  assert.deepEqual(providerInfo({ sttProvider: 'openai' }), { name: 'openai', audioRate: 24000, autoLang: true });
  assert.deepEqual(providerInfo({ sttProvider: 'deepgram' }), { name: 'deepgram', audioRate: 16000, autoLang: false });
  assert.deepEqual(providerInfo({ sttProvider: 'xfyun' }), { name: 'xfyun', audioRate: 16000, autoLang: true });
  assert.deepEqual(providerInfo({ sttProvider: 'mock' }), { name: 'mock', audioRate: 16000, autoLang: true });
  assert.deepEqual(providerInfo({ sttProvider: 'mock' }, 'openai'), { name: 'openai', audioRate: 24000, autoLang: true });
  assert.throws(() => providerInfo({ sttProvider: 'nope' }), /Unknown STT_PROVIDER/);

  const creds = (o) => ({ sttProvider: 'openai', openai: { apiKey: '' }, deepgram: { apiKey: '' }, xfyun: { appId: '', apiKey: '' }, funasr: { url: '' }, ...o });
  assert.deepEqual(availableProviders(creds({ openai: { apiKey: 'k' }, xfyun: { appId: 'a', apiKey: 'k' } })), ['openai', 'xfyun']);
  assert.deepEqual(availableProviders(creds({ sttProvider: 'mock' })), ['mock']);
  assert.deepEqual(availableProviders(creds({ funasr: { url: 'ws://127.0.0.1:10095' } })), ['funasr']);
  assert.deepEqual(providerInfo({ sttProvider: 'funasr' }), { name: 'funasr', audioRate: 16000, autoLang: true });
});
