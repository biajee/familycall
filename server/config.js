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
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function list(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  const sttProvider = env.STT_PROVIDER
    || (env.OPENAI_API_KEY ? 'openai' : env.DEEPGRAM_API_KEY ? 'deepgram' : 'mock');
  return {
    root: ROOT,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT ?? 8080),
    logLevel: env.LOG_LEVEL || 'info',
    roomKey: env.ROOM_KEY || '',
    sttProvider,
    sttPrompt: env.STT_PROMPT || '',
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
    stunUrls: list(env.STUN_URLS),
    turnUrls: list(env.TURN_URLS),
    turnSecret: env.TURN_SECRET || '',
    turnUser: env.TURN_USER || '',
    turnPass: env.TURN_PASS || '',
    turnTtlSec: Number(env.TURN_TTL || 12 * 3600),
  };
}
