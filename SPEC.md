# FamilyCall — spec

FamilyCall is video calling with live bilingual (Mandarin/English) captions
for a family member who is hard of hearing. **This app is the account,
billing, and room-management "shell"** — it owns nothing about media.
Identity is entirely owned by [zbackroom.com](https://zbackroom.com) — this
app has no login pages, password storage, or session table of its own.
Read `../zbackroom/SPEC.md` first for the cross-app contract this app
depends on (the shared cookie, the internal validate-session API).

**The actual video/audio and captioning happens in a separate app**,
`stt_videocall` (repo: `git@github.com:biajee/stt_videocall.git`), deployed
on its own VPS — WebRTC signaling, mic capture, speech-to-text streaming,
and the coturn TURN relay all live there, unchanged by this app's
existence. This app and the call server talk to each other over two small
server-to-server endpoints (below) — nothing about the call server's own
URL query-param contract (`room`/`name`/`lang`/`ui`/`simple`/`font`)
changed to support this.

## Stack

Next.js 15 (App Router) + TypeScript, Prisma 5 + SQLite — same pinned
versions as zbackroom/ConfirmPO (see zbackroom's SPEC.md for why they're
pinned; don't bump without checking that first).

## Data model (`prisma/schema.prisma`)

- **Account** — a local, FamilyCall-specific profile for a zbackroom
  identity. `id` is **not locally generated** — it's always set to match
  the `id` zbackroom's internal API returns, so a signed-in zbackroom user
  and their FamilyCall rooms/usage are the same record. `plan`/
  `planStatus` are a **synced mirror**, not the source of truth (that's
  zbackroom's `User`) — billing lives entirely at zbackroom.com.
- **Room** — one family pairing (e.g. a daughter and her father). `slug`
  is unique and **is the shared secret** — same spirit as the original
  single-family app's "treat it like a password." A room belongs to one
  `Account`; `deletedAt` is a soft delete (same pattern as ConfirmPO's
  `PurchaseOrder`) so an existing call link doesn't break mid-conversation
  just because the owner removed it from their dashboard.
- **RoomParticipant** — exactly two per room (`slot`: `"a"` | `"b"`,
  `@@unique([roomId, slot])`), matching `MAX_PEERS = 2` in the call
  server's `server/rooms.js`. `name`/`lang`/`ui`/`simple`/`font` are baked
  into that participant's call link by `lib/rooms.ts: buildCallLink()`.
- **CallSession** — one row per finished call, written only by
  `POST /api/internal/call-usage` (the call server reports it, this app
  never measures call time itself). `seconds` is the usage metric plan
  limits are enforced against.
- **AppLog**, **PageView** — same shape and same pattern as zbackroom/
  ConfirmPO's (not shared code, just applied a third time).

## Plan limits (`src/lib/plan.ts`)

Two separate limits, both `FREE`/`STARTER`/`BUSINESS`:
- `ROOM_LIMITS` — how many rooms an account may create: `FREE=1,
  STARTER=5, BUSINESS=null` (unlimited).
- `MINUTE_LIMITS` — call minutes per calendar month, the cost-driving
  metric (STT bills per minute): `FREE=60, STARTER=500, BUSINESS=null`.

**These numbers are placeholders** — chosen for the initial build, not
validated against real STT costs. Tune before real launch.

### ⚠️ The `null`-means-unlimited gotcha

Both limit maps use `null` on purpose for `BUSINESS` (unlimited). **Never**
read them with `map[plan] ?? fallback` — `??` treats an on-purpose `null`
exactly like a missing key and silently substitutes the fallback, capping
BUSINESS at the FREE limit. This was a real, shipped bug in ConfirmPO
(caught before any real Business customer existed — see its SPEC.md).
`limitFor()` in `lib/plan.ts` checks `plan in map` first; use it (or the
exported `assertUnderRoomLimit`/`minutesRemaining` helpers) for any new
per-plan limit, never `??`.

## Auth delegation to zbackroom (`src/lib/auth.ts`)

Same shape as ConfirmPO's: `getCurrentUser()` reads the shared
`zbackroom_session` cookie (hardcoded to match zbackroom's exactly),
calls zbackroom's `/api/internal/validate-session`, and `upsert`s a local
`Account` row keyed by the returned `id`. One network call per check, not
cached. An unauthenticated page visit redirects to
`zbackroomLoginUrl(path)` — an absolute URL, since zbackroom's own
relative-redirect defaults resolve against *its* domain.

No public REST API and no inbound-email handling in this app (unlike
ConfirmPO) — there was nothing to build here for v1, so
`getApiAccount`/`inboundEmailAddress` were deliberately left out rather
than copied speculatively. Room ownership is a plain `room.accountId ===
user.id` check — there's no "receiver" concept like ConfirmPO's PO access,
since the actual call participants (the elderly parent, the family member)
use plain unguessable links and never sign in.

## Call-server integration contract

These are the only two points where this app and the call server
(`stt_videocall`, its own repo and VPS) talk to each other. Both are
bearer-secret, server-to-server only — never call either from a browser.

**The bearer secret is `INTERNAL_API_SECRET` on this app's side, but
`FAMILYCALL_INTERNAL_SECRET` on the call server's side — a deliberately
different value from zbackroom/ConfirmPO's shared `INTERNAL_API_SECRET`.**
The call server accepts arbitrary inbound WebSocket connections from the
open internet (a materially bigger attack surface than any other app in
the suite), so it shouldn't hold a secret that would also let a caller
resolve zbackroom sessions or read ConfirmPO's admin data. Generate this
one independently with `openssl rand -hex 32` and set it only in this
app's `.env` (`INTERNAL_API_SECRET`) and the call server's `.env`
(`FAMILYCALL_INTERNAL_SECRET`).

- `GET /api/internal/validate-room?slug=<slug>` — called by the call
  server's `server/familycall.js: validateRoom()` before/at join.
  `404` = no such room (reject the join outright). `200 { ok: true,
  roomId, participants: [{slot,name,lang}] }` = go ahead. `200 { ok:
  false, reason: "quota_exceeded" }` = the room is real but this month's
  plan minutes are used up — the call server shows a specific
  upgrade-prompt message instead of a generic error.
- `POST /api/internal/call-usage` — body `{ slug, startedAt, endedAt,
  seconds }`, called when a room's peer count drops back below 2 (a call
  just ended). Creates a `CallSession`. A lookup miss here still acks
  `200` (logged as a `WARN`) — see stt_videocall's own SPEC/comments for
  why the call server never blocks a hangup on this call succeeding.

**Reliability posture** (documented on the call-server side, repeated here
since it's a joint decision): the call server fails **open** (lets the
call proceed) on a network error or timeout reaching this app, and fails
**closed** (rejects) only on an explicit `{ ok: false }` response. A brief
outage of this app should never be the reason a hard-of-hearing family
member can't reach their family — enforcement lags reliability on purpose.

## Admin (`/api/internal/admin-data`) — consumed by zbackroom's `/admin`

Same bearer-secret pattern as zbackroom/ConfirmPO's (using
`INTERNAL_API_SECRET`, the shared one — this endpoint is only ever called
by zbackroom itself, not the call server, so it doesn't need the separate
secret above). Returns account list (plan/status/room count/joined), total
rooms, calls-this-month count + total minutes, a recent-calls feed
(account email, room label, duration), `AppLog` (with `?level=` filter),
and `PageView` rows — same shape family as ConfirmPO's, minus anything
PO-specific (no AI usage, no format readers, no leads — none of that
applies here).

## Page-view logging

Identical setup to zbackroom/ConfirmPO: `src/middleware.ts` tags each
request with `x-pathname`/`x-method` (Prisma isn't available in Edge
middleware), `lib/pageview.ts: logPageView()` (called from the root
layout, Node runtime) writes the `PageView` row, GET-only, never throws.

## UI

Same `site-header`/`wrap`/`wordmark` CSS structure as zbackroom/ConfirmPO
(`src/app/layout.tsx`, own accent color: teal, not ConfirmPO's blue) so
every app in the suite reads as one product. `/account` mirrors
ConfirmPO's — this app doesn't manage its own profile/password UI, it
just links out to zbackroom.com for both account and billing.

## Env vars

See `.env.example` for the authoritative list: `DATABASE_URL`, `APP_URL`,
`ZBACKROOM_URL`, `INTERNAL_API_SECRET` (must match zbackroom's — this is
the *suite-shared* one, not the call-server one described above),
`CALL_SERVER_URL` (the stt_videocall deployment's public URL, used only to
build shareable links). `ADMIN_EMAILS` and every zbackroom-suite-wide
setting live at zbackroom.com, not here.

## Deploy

Same Ubuntu box as zbackroom/ConfirmPO, SSH alias `zbackroom`. This app
lives at `/var/www/familycall`, runs as systemd service `familycall` on
port 3002, behind nginx (`deploy/nginx-familycall.conf` proxies
`familycall.zbackroom.com` → `127.0.0.1:3002`). The call server
(`stt_videocall`) is a **separate VPS, unchanged deploy** — nothing about
its Caddy/coturn/systemd setup moves here.

- **Sync code**: `deploy/sync.sh` (rsync, excludes `prisma/*.db*` **by
  wildcard, not a literal filename** — see zbackroom's SPEC.md for the
  exact incident that happened when a sibling app's sync script got this
  wrong).
- **Apply + build + restart**: `deploy/deploy.sh` — `prisma db push`,
  build into a fresh `.next` while the old build keeps serving, then
  `systemctl restart` (sub-second downtime).
- **Backups**: `familycall-backup.timer` runs `deploy/backup.sh` daily →
  `/var/backups/familycall`, 7-day retention.
