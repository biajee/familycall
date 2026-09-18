import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader (KEY=VALUE, # comments, optional quotes). Existing env vars win. */
export function loadDotEnv(path = resolve(ROOT, '.env')) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    const trimmed = val.trim();
    const q = trimmed[0];
    if (q === '"' || q === "'") {
      const end = trimmed.indexOf(q, 1);
      val = end > 0 ? trimmed.slice(1, end) : trimmed;
    } else {
      // Strip inline comments: a # at the start of the value or preceded by
      // whitespace ("KEY=v  # note", "KEY=   # note"); keep # inside values.
      const hash = val.search(/(^|\s)#/);
      val = (hash !== -1 ? val.slice(0, hash) : val).trim();
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function list(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  const sttProvider = env.STT_PROVIDER
    || (env.OPENAI_API_KEY ? 'openai'
      : env.DEEPGRAM_API_KEY ? 'deepgram'
        : env.XFYUN_APP_ID && env.XFYUN_API_KEY ? 'xfyun'
          : env.FUNASR_URL ? 'funasr' : 'mock');
  return {
    root: ROOT,
    dataDir: env.DATA_DIR || resolve(ROOT, 'data'),
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT ?? 8080),
    logLevel: env.LOG_LEVEL || 'info',
    roomKey: env.ROOM_KEY || '',
    // FamilyCall shell app (separate Next.js app, familycall.zbackroom.com)
    // — room ownership/plan-quota checks and call-usage reporting. A
    // deliberately different secret from any zbackroom-suite
    // INTERNAL_API_SECRET: this server takes arbitrary inbound WebSocket
    // connections from the open internet, a bigger attack surface than any
    // app-to-app call in that suite. Empty shellUrl = legacy/local mode
    // (no shell configured), see server/familycall.js.
    familycall: {
      shellUrl: env.FAMILYCALL_SHELL_URL || '',
      secret: env.FAMILYCALL_INTERNAL_SECRET || '',
    },
    sttProvider,
    sttPrompt: env.STT_PROMPT || '',
    sttHotwords: env.STT_HOTWORDS || '', // FunASR hot words, e.g. {"爸爸":20}
    sttIdleCloseMs: Number(env.STT_IDLE_CLOSE_MS || 45_000),
    openai: {
      apiKey: env.OPENAI_API_KEY || '',
      url: env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime?intent=transcription',
      model: env.OPENAI_TRANSCRIBE_MODEL || 'gpt-live-transcribe',
      delay: env.OPENAI_TRANSCRIBE_DELAY || 'low',
      noiseReduction: env.OPENAI_NOISE_REDUCTION ?? 'near_field',
    },
    deepgram: {
      apiKey: env.DEEPGRAM_API_KEY || '',
      url: env.DEEPGRAM_URL || 'wss://api.deepgram.com/v1/listen',
      model: env.DEEPGRAM_MODEL || 'nova-3',
    },
    xfyun: {
      appId: env.XFYUN_APP_ID || '',
      apiKey: env.XFYUN_API_KEY || '',
      apiSecret: env.XFYUN_API_SECRET || '', // set -> 实时语音转写大模型 (new_rta) endpoint
      service: env.XFYUN_SERVICE || 'auto', // auto | rtasr_llm | rtasr
      url: env.XFYUN_RTASR_URL || 'wss://rtasr.xfyun.cn/v1/ws',
      llmUrl: env.XFYUN_LLM_URL || 'wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1',
    },
    funasr: {
      url: env.FUNASR_URL || '', // e.g. ws://127.0.0.1:10095 (self-hosted, see README)
    },
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || '',
      privateKey: env.VAPID_PRIVATE_KEY || '',
      subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    },
    stunUrls: list(env.STUN_URLS),
    turnUrls: list(env.TURN_URLS),
    turnSecret: env.TURN_SECRET || '',
    turnUser: env.TURN_USER || '',
    turnPass: env.TURN_PASS || '',
    turnTtlSec: Number(env.TURN_TTL || 12 * 3600),
  };
}
