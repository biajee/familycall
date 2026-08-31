# stt-videocall · 家庭通话

A self-hosted, one-to-one **video call app with live captions in Mandarin Chinese and English**, built for a
family member who is hard of hearing. Everything either person says is transcribed and shown as large text on
**both** phones, in real time.

It was designed around one specific situation — a daughter in the USA calling her father in mainland China — so it
deliberately avoids every service the Great Firewall blocks (Google STUN, Firebase, App Store distribution to
China, etc.). Both phones only ever talk to **your own server**.

```
   Wife's phone (USA)                     Your VPS                          Dad's phone (China)
 ┌──────────────────┐   WebRTC video/audio (P2P, or relayed by coturn)   ┌──────────────────┐
 │  camera + mic    │◄══════════════════════════════════════════════════►│  camera + mic    │
 │                  │                                                    │                  │
 │  own mic as PCM ─┼──► ┌──────────────┐  audio  ┌────────────────┐    │                  │
 │                  │    │ Node server  │────────►│ STT provider   │    │                  │
 │  captions ◄──────┼─── │ (signaling + │◄────────│ OpenAI/Deepgram│    │                  │
 │                  │    │  captions)   │  text   └────────────────┘    │                  │
 │                  │    │              │─────────── captions (text) ───┼─► big captions   │
 └──────────────────┘    └──────────────┘◄────────── own mic as PCM ────┼──               │
                                                                        └──────────────────┘
```

* **Video/audio**: plain WebRTC between the two phones, through your own coturn server when the networks need it.
* **Captions**: each phone streams its *own* microphone (16/24 kHz PCM) to the server over the same WebSocket it
  uses for signaling. The server transcribes it with the speaker's language (中文 / English / auto) and broadcasts
  the text to both phones. The critical path — daughter's speech → text on Dad's screen — sends only **text**
  across the border.
* **App**: a Progressive Web App. Open a link, tap "Add to Home Screen", and it behaves like an app on both iPhone
  and Android — no App Store, no APK sideloading, no Google Play Services (which Chinese Android phones lack).
  The same code can be wrapped with Capacitor later if a store-distributed native app is ever wanted.

## What you need

1. **A VPS** with a public IPv4 (1 vCPU / 1 GB is plenty). For the China leg, a **Hong Kong, Tokyo, Singapore or
   US-West** location works best (Vultr, DigitalOcean, Linode, Alibaba Cloud HK …). Ubuntu 22.04/24.04.
2. **A domain / subdomain** pointed at the VPS (e.g. `call.example.com`). HTTPS is mandatory: browsers only allow
   camera + microphone on secure origins.
3. **A speech-to-text API key** — one of:
   * **OpenAI** (`OPENAI_API_KEY`) — default. Uses the Realtime transcription session with `gpt-live-transcribe`,
     which handles Mandarin and English (including switching between them) with streaming partial results.
   * **Deepgram** (`DEEPGRAM_API_KEY`) — Nova-3 supports `zh-CN` and `en-US`; cheaper, but no mixed-language
     mode for Chinese, so each speaker must pick one language.

   Both are cheap for family use: a 30-minute call transcribes ~60 minutes of audio (both sides). Check the
   vendor's current per-minute pricing; expect it to be on the order of cents per call.

## Quick start (local, fake captions)

```bash
npm install
npm run dev              # STT_PROVIDER=mock → fake captions, no API key needed
# open http://localhost:8080/?room=test&name=Alice in two browser tabs/windows
```

Tests:

```bash
npm test                 # unit + integration tests (rooms, TURN creds, resampler, providers, WebSocket flow)
npm run test:e2e         # two headless Chrome "phones" with fake camera/mic: call + captions + hang-up + re-join
                         # (needs puppeteer: npm i -D puppeteer)
```

## Deploy to the VPS

```bash
# on your machine
rsync -a --exclude node_modules --exclude .env ./ root@YOUR_VPS:/root/stt-videocall/

# on the VPS
cd /root/stt-videocall
DOMAIN=call.example.com bash deploy/setup-vps.sh
nano /opt/stt-videocall/.env          # paste OPENAI_API_KEY=... (or DEEPGRAM_API_KEY=...)
systemctl restart stt-videocall
curl https://call.example.com/healthz  # {"ok":true,"provider":"openai",...}
```

The script installs Node 20, Caddy (automatic Let's Encrypt HTTPS + WebSocket proxy), coturn (TURN/STUN with
time-limited credentials), a hardened systemd service, and opens the firewall ports
(80, 443, 3478 tcp/udp, 5349 tcp, 49152–65535 udp). Re-running it is safe; it keeps your `.env`.

Logs: `journalctl -u stt-videocall -f`, `tail -f /var/log/turnserver.log`.

## Setting up the two phones

Everything about a phone is in its link, so you can prepare both links on your computer and send them by WeChat.

The easy way: open the app, fill in the room, and tap **📋 复制房间链接 / Copy room link** (also offered on the
call screen while you wait for the other person). It copies a generic invite — just the room (and key) — that you
can paste into WeChat. Anyone who opens it can join with one tap: they get simple mode, their phone's own
language, and an automatically assigned name. For per-person settings, build the link by hand:

| Parameter | Meaning |
|-----------|---------|
| `room`    | Both phones must use the same room name. Treat it like a password: use something unguessable, e.g. `wang-family-7h3k9q`. |
| `name`    | This person's name (爸爸, 女儿, …); shown in the settings screen. Captions show direction by alignment: incoming on the left, your own on the right. |
| `lang`    | What this person speaks: `zh-CN`, `en-US`, or `auto` (中/英 mixed; OpenAI only). |
| `ui`      | Interface language: `zh` or `en`. |
| `simple=1`| Simple mode: the app opens with a single huge "开始通话" button (for Dad). |
| `font`    | Starting caption size in px (default 30; 36–44 is comfortable for older eyes). |
| `key`     | Only if you set `ROOM_KEY` in `.env`. |

**Dad (China, Chinese UI, simple mode):**

```
https://call.example.com/?room=wang-family-7h3k9q&name=爸爸&lang=zh-CN&ui=zh&simple=1&font=40
```

**Wife (USA):** `lang=auto` lets her switch between Mandarin and English mid-call (with OpenAI).

```
https://call.example.com/?room=wang-family-7h3k9q&name=女儿&lang=auto&ui=zh
```

(Anyone else in the US household can use a third link with their own name and `lang=en-US` — but only two
phones can be in a room at the same time.)

### Installing on the home screen

* **iPhone**: open the link in **Safari** → Share button → **Add to Home Screen** (添加到主屏幕). Launch it from
  the icon from then on; allow camera and microphone when asked.
* **Android (Huawei/Xiaomi/OPPO/vivo, Chrome or the vendor browser)**: open the link → browser menu (⋮) →
  **Add to Home screen / Install app** (添加到桌面).
* If the link is opened inside **WeChat**, tap ⋯ → **Open in browser** (在浏览器打开) first. WeChat's built-in
  browser does not reliably grant camera/microphone access.

The link's query string is preserved in the installed app (the server generates the web-app manifest per link),
so Dad's icon always opens straight into the family room with the Chinese UI and big captions.

### Making a call

There is no ringing (yet). Agree on a time (or send a WeChat message "打开家庭通话"), both tap the icon, then
**开始通话 / Start call**. Whoever opens it first sees "等待对方加入…" until the other one joins.

In-call buttons: 🎤 mute · 📷 camera off · 🔄 front/back camera · A− / A+ caption size · 📵 hang up.
The dot above the captions is green when the caption service is connected.

## Configuration (`.env`)

See [`.env.example`](.env.example) for every option. The important ones:

| Variable | Default | Notes |
|----------|---------|-------|
| `STT_PROVIDER` | auto (`openai` if key set, else `deepgram`, else `mock`) | |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-live-transcribe` | `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` also work. |
| `OPENAI_TRANSCRIBE_DELAY` | `low` | `minimal` … `xhigh`: lower = faster partial text, higher = more accurate. |
| `DEEPGRAM_MODEL` | `nova-3` | |
| `STT_PROMPT` | a short family-call description | Add names/places that come up often to improve recognition. |
| `TURN_URLS`, `TURN_SECRET` | set by `setup-vps.sh` | Credentials are HMAC time-limited (`TURN_TTL`). |
| `ROOM_KEY` | empty | Extra shared secret; phones must include `?key=`. |
| `HOST` / `PORT` | `127.0.0.1:8080` | Behind Caddy. |

## Notes on the China ↔ USA leg

* **Never depend on Google/Firebase** for anything in the call path; `stun.l.google.com` is blocked. Your coturn
  server provides STUN as well, so `STUN_URLS` can stay empty.
* Cross-border UDP is sometimes throttled. The app offers `turn:` UDP, `turn:` TCP and `turns:` TLS (port 5349)
  and the browser picks whichever works. If calls still fail to connect, the classic fix is running the TLS
  TURN listener on port **443** on a second IP or a separate VPS, which looks like ordinary HTTPS traffic.
* Video is capped at ~700 kbps / 640×480 / 20 fps to survive lossy international links; audio (and therefore
  captions) has priority. Use the 📷 button to go audio-only on a bad connection — captions keep working.
* Dad's phone sends its mic audio to the server for *his* captions. If his upload is poor, that only delays his
  own captions on the daughter's screen; her captions on his screen are unaffected.
* The server keeps no recordings: audio is streamed to the STT provider and discarded; captions are not stored.

## How it is built

```
server/
  index.js        entry point (loads .env, starts the app)
  app.js          HTTP static + WebSocket: rooms, signaling relay, audio ingress, caption broadcast
  rooms.js        room state, 2-peer limit, polite/impolite assignment for perfect negotiation
  turn.js         TURN REST credentials (coturn use-auth-secret)
  static.js       static files + per-link web-app manifest
  stt/            transcriber providers: base.js (reconnecting WS), openai.js, deepgram.js, mock.js
public/
  app.js          UI + call lifecycle          peer.js      RTCPeerConnection, perfect negotiation, ICE restart
  signaling.js    reconnecting WebSocket       capture.js   mic → AudioWorklet → int16 PCM chunks
  pcm-worklet.js  worklet processor            resampler.js shared linear resampler (also unit-tested in Node)
  captions.js     caption rendering            i18n.js      zh / en strings
  sw.js, manifest, icons/
deploy/           Caddyfile, turnserver.conf, systemd unit, setup-vps.sh, copy-turn-cert.sh
test/             node:test suites + test/e2e/run.js (puppeteer)
```

Wire protocol (one WebSocket per phone at `/ws`): text frames are JSON control messages
(`join`, `signal`, `update`, `leave` → `joined`, `peer-joined`, `peer-left`, `signal`, `caption`, `stt-status`,
`error`); binary frames are the phone's own microphone as int16 mono PCM at the rate the server announced in
`joined.stt.audioRate` (24 kHz for OpenAI, 16 kHz for Deepgram/mock).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| "Cannot reach the server" | DNS/HTTPS not ready, or the systemd service is down (`journalctl -u stt-videocall`). |
| Stuck on "Connecting…" with both phones in the room | TURN not reachable: check `ufw status`, `/var/log/turnserver.log`, that `TURN_URLS` uses your domain, and `external-ip` in `/etc/turnserver.conf`. Test with the browser's `chrome://webrtc-internals`. |
| Red dot / "Captions not connected" | Wrong or missing API key, or the provider rejected the session — server log shows the vendor's error. |
| Captions in the wrong language | The speaker's `lang` parameter (or Settings) picks the recognizer language. With Deepgram there is no `auto`. |
| No sound from the other side on iPhone | Tap the video once (browser autoplay rule); check the silent switch. |
| Camera blocked | Phone Settings → Safari/Chrome → Camera & Microphone → Allow. WeChat's browser: open in Safari/Chrome instead. |

## Ideas for later

* **Translation**: when the caller speaks English, show Dad a Chinese translation under the English caption
  (the server already has the text; one LLM call per final segment).
* **Ringing**: Web Push notification ("女儿在等你 / your daughter is calling") so Dad does not have to be told
  by WeChat first.
* **Native wrapper** with Capacitor if a store app is ever needed (the web app runs unchanged inside it).
* **Transcript**: save the captions of a call as a text file for re-reading.
