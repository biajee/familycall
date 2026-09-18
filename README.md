# FamilyCall

Video calls with live bilingual (Mandarin/English) captions, for a family
member who is hard of hearing. This is the **account, billing, and room
management** shell — one login/subscription across the
[zbackroom.com](https://zbackroom.com) app suite, same as
[ConfirmPO](https://confirmpo.zbackroom.com). See [`SPEC.md`](./SPEC.md)
for the architecture and the contract this app shares with the call
server.

**The actual video/audio and live-caption engine is a separate app**,
`stt_videocall`, deployed on its own VPS (WebRTC signaling, mic capture,
speech-to-text streaming, coturn TURN relay) — this app never touches
media, it just creates rooms, generates the two shareable call links per
room, tracks usage against a plan, and delegates identity to zbackroom.com.

## Local dev

```bash
npm install
npx prisma db push   # creates/updates dev.db
npm run dev
```

Needs a `.env` — copy `.env.example` and fill it in. To actually sign in
locally you need zbackroom running too (`ZBACKROOM_URL` pointed at it, and
`INTERNAL_API_SECRET` matching exactly between the two `.env` files) —
without that, every signed-in page just redirects to a login that can't
complete. The marketing homepage (`/`) renders fine standalone.

`CALL_SERVER_URL` only needs to point at a real call-server deployment to
produce working call links — it can be left as the placeholder for local
UI work on the room dashboard.

## Deploy

See the "Deploy" section of `SPEC.md`.
