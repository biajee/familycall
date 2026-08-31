import { loadDotEnv, loadConfig } from './config.js';
import { createApp } from './app.js';

loadDotEnv();
const cfg = loadConfig();
const app = createApp(cfg);

const addr = await app.listen();
app.log.info(`stt-videocall listening on http://${addr.address}:${addr.port} (STT provider: ${app.stt.name}, ${app.stt.audioRate} Hz)`);
if (app.stt.name === 'mock') app.log.warn('Using the MOCK transcriber: captions are fake. Set OPENAI_API_KEY or DEEPGRAM_API_KEY (or STT_PROVIDER) for real captions.');
if (!cfg.turnUrls.length) app.log.warn('No TURN_URLS configured: calls between different networks (USA <-> China) will usually fail without a TURN server.');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
