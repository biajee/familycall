import WebSocket from 'ws';
import { WsTranscriber } from './base.js';

/** App language -> OpenAI transcription language hints. */
export function openaiLanguages(lang) {
  if (lang === 'auto') return ['zh-cn', 'en'];
  if (lang.startsWith('zh')) return ['zh-cn'];
  return ['en'];
}

const COMMIT_SILENCE_MS = 1200; // finalize an utterance after this much delta silence
const MAX_UTTERANCE_MS = 15_000; // force a caption boundary during continuous speech
const COMMIT_COOLDOWN_MS = 1000;

/**
 * OpenAI Realtime API, transcription-only session.
 * Docs: https://developers.openai.com/api/docs/guides/realtime-transcription
 */
export class OpenAITranscriber extends WsTranscriber {
  static audioRate = 24000;
  static autoLang = true;

  constructor(opts) {
    super(opts);
    this.cfg = opts.cfg.openai;
    this.prompt = opts.cfg.sttPrompt;
    this.items = new Map();
    this._pendingSince = 0; // first delta of the current uncommitted utterance
    this._lastDeltaAt = 0;
    this._lastCommitAt = 0;
    this._commitTimer = null;
  }

  get _isLive() {
    return this.cfg.model.startsWith('gpt-live');
  }

  _open() {
    if (!this.cfg.apiKey) throw new Error('OPENAI_API_KEY is not set');
    // No OpenAI-Beta header: that selects the retired beta protocol
    // ("The Realtime Beta API is no longer supported").
    return new WebSocket(this.cfg.url, {
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
    });
  }

  _sessionConfig() {
    const langs = openaiLanguages(this.lang);
    const transcription = { model: this.cfg.model };
    if (this.cfg.model.startsWith('gpt-live')) {
      transcription.languages = langs;
      transcription.delay = this.cfg.delay;
    } else if (this.lang !== 'auto') {
      transcription.language = langs[0].split('-')[0];
    }
    if (this.prompt) transcription.prompt = this.prompt;
    const nr = this.cfg.noiseReduction;
    const input = {
      format: { type: 'audio/pcm', rate: OpenAITranscriber.audioRate },
      noise_reduction: nr && nr !== 'none' ? { type: nr } : null,
      transcription,
    };
    if (!this.cfg.model.startsWith('gpt-live')) {
      // gpt-live-* models handle turn-taking themselves (see `delay`) and
      // reject turn_detection; the gpt-4o-* transcribe models still need VAD.
      input.turn_detection = {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
      };
    }
    return {
      type: 'session.update',
      session: { type: 'transcription', audio: { input } },
    };
  }

  _onOpen() {
    this.ws.send(JSON.stringify(this._sessionConfig()));
    // gpt-live models never finalize an item on their own (turn_detection is
    // unsupported): the client must commit the audio buffer to close each
    // utterance, otherwise captions grow as one endless interim segment.
    clearInterval(this._commitTimer);
    if (this._isLive) {
      this._commitTimer = setInterval(() => {
        if (this.closed) { clearInterval(this._commitTimer); return; }
        this._maybeCommit(Date.now());
      }, 250);
    }
  }

  _maybeCommit(now) {
    if (!this._pendingSince || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (now - this._lastCommitAt < COMMIT_COOLDOWN_MS) return false;
    const quiet = now - this._lastDeltaAt >= COMMIT_SILENCE_MS;
    const tooLong = now - this._pendingSince >= MAX_UTTERANCE_MS;
    if (!quiet && !tooLong) return false;
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this._lastCommitAt = now;
    this._pendingSince = 0;
    return true;
  }

  _beforeClose() {
    clearInterval(this._commitTimer);
  }

  _sendAudio(buf) {
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'session.created':
      case 'session.updated':
      case 'transcription_session.updated':
        this.opts.onStatus?.(true, 'ok');
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const now = Date.now();
        if (!this._pendingSince) this._pendingSince = now;
        this._lastDeltaAt = now;
        const acc = (this.items.get(msg.item_id) || '') + (msg.delta || '');
        this.items.set(msg.item_id, acc);
        this.emit({ key: msg.item_id, text: acc.trim(), final: false });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
        this._pendingSince = 0;
        this.items.delete(msg.item_id);
        this.emit({ key: msg.item_id, text: (msg.transcript || '').trim(), final: true });
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.items.delete(msg.item_id);
        this.log?.warn('openai transcription failed:', msg.error?.message || msg.error);
        break;
      case 'error':
        // A commit that raced the end of an utterance (no new audio) is benign.
        if (msg.error?.code === 'input_audio_buffer_commit_empty') break;
        this.log?.error('openai error:', msg.error?.message || JSON.stringify(msg.error));
        this.opts.onStatus?.(false, msg.error?.message || 'error');
        break;
      default:
        break;
    }
  }
}
