# FamilyCall

Video calls with live bilingual (Mandarin/English) captions, for a family
member who is hard of hearing. This is the **account, billing, and room
management** shell — one login/subscription across the
[zbackroom.com](https://zbackroom.com) app suite, same as
[ConfirmPO](https://confirmpo.zbackroom.com). See [`SPEC.md`](./SPEC.md)
for the architecture and the contract this app shares with the call
server.

**The actual video/audio and live-caption engine lives in this same repo,
at [`callserver/`](./callserver)** — but still deploys as its own process
(WebRTC signaling, mic capture, speech-to-text streaming, plus a coturn
TURN relay), independently of this app, on the same box at
`call.zbackroom.com`. One repo, two deployments:
this app never touches media, it just creates rooms, generates the two
shareable call links per room, tracks usage against a plan, and delegates
identity to zbackroom.com. See [`callserver/README.md`](./callserver/README.md)
for that half.

## Local dev

```bash
npm install
npx prisma db push   # creates/updates dev.db
npm run dev
```

`callserver/` is a separate Node project with its own `package.json` —
`cd callserver && npm install && npm run dev` to run it locally too (see
its own README for the STT provider setup).

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
