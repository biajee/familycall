# FamilyCall — spec

FamilyCall is video calling with live bilingual (Mandarin/English) captions
for a family member who is hard of hearing. **This app is the account,
billing, and room-management "shell"** — it owns nothing about media.
Identity is entirely owned by [zbackroom.com](https://zbackroom.com) — this
app has no login pages, password storage, or session table of its own.
Read `../zbackroom/SPEC.md` first for the cross-app contract this app
depends on (the shared cookie, the internal validate-session API).

**The actual video/audio and captioning happens in a separate app that
lives at `callserver/` in this same repo** (merged in from its original
`stt_videocall` repo via `git subtree` — full commit history preserved,
just check `git log <merge-commit>^2` if `git log -- callserver/` looks
short, since `git log`'s default simplification collapses merge history).
It still **deploys independently, on its own VPS** — WebRTC signaling, mic
capture, speech-to-text streaming, and the coturn TURN relay all live
there, unchanged by this app's existence or by which repo the source sits
in. This app and the call server talk to each other over two small
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
  `planStatus` are a **synced mirror** of this app's own zbackroom
  subscription (`plans.familycall` in the identity response; `FREE`/`FAMILY`/
  `FAMILY_PLUS`), not the source of truth — billing lives entirely at
  zbackroom.com, where each app has its own subscription.
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
  never measures call time itself). **Informational only** (history on the
  room page, totals in `/admin`): calls are unlimited, so nothing is
  enforced against it.
- **CaptionUsage** — one row per phone per stay in a room, written only by
  `POST /api/internal/caption-usage`: `seconds` of audio that phone sent to
  speech-to-text. **This is what plan limits are enforced against.** It's a
  separate table from `CallSession` on purpose: captions can run while
  someone waits alone in a room (no two-person "call" exists yet but the STT
  cost is already being incurred), and a call with captions off costs
  nothing.
- **AppLog**, **PageView** — same shape and same pattern as zbackroom/
  ConfirmPO's (not shared code, just applied a third time).

## Plan limits (`src/lib/plan.ts`)

**Calls are unlimited on every plan**, including Free. What plans differ
on is live captions (the cost-driving resource: speech-to-text bills per
minute of audio) and how many rooms an account may have. One `PLANS` table
in `lib/plan.ts` drives both the limits and the marketing page's pricing
section, so they can't drift:

| Plan | Price | Live-caption minutes / month | Rooms |
|------|-------|------------------------------|-------|
| Free | $0 | 5 | 1 |
| Family | $5/mo | 120 | 2 |
| Family Plus | $12/mo | 600 | 5 |

Prices are also set in zbackroom (its `APPS` catalog for what checkout
shows, and `deploy/setup-square-familycall-catalog.js` for what Square
actually charges); change a price in all three places. **The numbers are
placeholders**: chosen for the initial build, not validated against real
STT costs or real usage. Tune before a real launch.

### What a "caption minute" is

Seconds of audio actually sent to the speech-to-text provider, **summed
over both phones**, charged to the room owner's account for the calendar
month. The consequence worth knowing: if both people talk at once the
allowance drains at twice the wall clock, so Free's 5 minutes is about 2.5
minutes of genuinely two-way conversation. Either phone can switch the
other side's captions off (existing button), which stretches it. The
marketing page says this in plain words.

### How it's enforced

The call server does the enforcing, this app supplies the numbers. On the
**first** phone joining a room, `validate-room` returns
`captionSecondsRemaining` (plan allowance minus this month's `CaptionUsage`
for the owner's rooms; `null` = unlimited). The call server meters each
audio frame against it. When it hits zero, captions stop on both phones
with a one-time notice, **and the call carries on untouched**. Each phone
reports its seconds when it leaves. Known, accepted limits: usage is
reported on leave, so a call-server crash loses that in-flight session, and
two rooms of one account running at the same moment can overshoot a little,
since each was told the same remaining time when it started.

### ⚠️ The `null`-means-unlimited gotcha

A plan's limits may be `null` (unlimited) on purpose; none are today, but
the type allows it. **Never** read a limit with `map[plan] ?? fallback`:
`??` treats an on-purpose `null` exactly like a missing key and silently
substitutes the fallback, capping an unlimited plan at the Free limit. This
was a real, shipped bug in ConfirmPO (caught before any real Business
customer existed, see its SPEC.md). `planDef()` in `lib/plan.ts` checks
`plan in PLANS` first; read limits through it (or the exported
`assertUnderRoomLimit`/`captionSecondsRemaining` helpers), never `??`.

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

These are the only points where this app and the call server
(`callserver/`, its own deploy despite living in this repo now) talk to
each other: one lookup and two reports. All are bearer-secret,
server-to-server only — never call any from a browser.

**The bearer secret is `FAMILYCALL_INTERNAL_SECRET` — its own env var on
both sides, identical between this app's `.env` and the call server's
`.env`, and deliberately a DIFFERENT value from the suite-shared
`INTERNAL_API_SECRET`** (which this app still uses separately, for its own
`getCurrentUser()` call to zbackroom and for `/api/internal/admin-data`).
The call server accepts arbitrary inbound WebSocket connections from the
open internet (a materially bigger attack surface than any other app in
the suite), so it shouldn't hold a secret that would also let a caller
resolve zbackroom sessions or read ConfirmPO's admin data. Generate it
independently with `openssl rand -hex 32` and set the same value as
`FAMILYCALL_INTERNAL_SECRET` in both `.env` files.

- `GET /api/internal/validate-room?slug=<slug>` — called by the call
  server's `server/familycall.js: validateRoom()` on every join. `404` = no
  such room (reject the join). Otherwise `200 { ok: true, roomId,
  captionSecondsRemaining, participants: [{slot,name,lang}] }` and **the
  call is always allowed**. `captionSecondsRemaining` is the room owner's
  live-caption time left this month, `null` for unlimited, and `0` once
  it's spent; the call server enforces it (see "How it's enforced" above).
- `POST /api/internal/caption-usage` — body `{ slug, seconds }`, sent when
  a phone leaves a room: seconds of audio that phone sent to speech-to-text.
  Creates a `CaptionUsage`. `seconds` must be positive (the call server
  skips zero); an unknown slug still acks `200` (logged as a `WARN`).
- `POST /api/internal/call-usage` — body `{ slug, startedAt, endedAt,
  seconds }`, sent when a room drops back below two phones (a call just
  ended). Creates a `CallSession`. Informational. A lookup miss still acks
  `200` (logged as a `WARN`).

Both reports are fire-and-forget on the call server's side and best-effort
here, so a reporting failure can never be why someone couldn't hang up.

**Reliability posture** (documented on the call-server side, repeated here
since it's a joint decision): the call server fails **open** when this app
is unreachable, errors, or isn't configured — the call proceeds and
captions are simply unmetered — and fails **closed** only on an explicit
`404` (the room doesn't exist). A brief outage of this app should never be
the reason a hard-of-hearing family member can't reach their family, or
lose captions mid-call; enforcement lags reliability on purpose.

## Admin (`/api/internal/admin-data`) — consumed by zbackroom's `/admin`

Same bearer-secret pattern as zbackroom/ConfirmPO's (using
`INTERNAL_API_SECRET`, the shared one — this endpoint is only ever called
by zbackroom itself, not the call server, so it doesn't need the separate
secret above). Returns account list (plan/status/room count/joined), total
rooms, calls-this-month count + call minutes, **caption minutes this
month** (the metered resource), a recent-calls feed
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

Same Ubuntu box as zbackroom/ConfirmPO/alerty, SSH alias `zbackroom`. This app
lives at `/var/www/familycall`, runs as systemd service `familycall` on
port 3003 (3000 is ConfirmPO, 3001 zbackroom, 3002 alerty), behind nginx (`deploy/nginx-familycall.conf` proxies
`familycall.zbackroom.com` → `127.0.0.1:3003`). The call server
(`callserver/`) is a **separate VPS, unchanged deploy, despite now living
in this repo** — nothing about its Caddy/coturn/systemd setup moves here;
see `callserver/README.md`'s own "Deploy to the VPS" for that half.

- **Sync code**: `deploy/sync.sh` (rsync, excludes `prisma/*.db*` **by
  wildcard, not a literal filename** — see zbackroom's SPEC.md for the
  exact incident that happened when a sibling app's sync script got this
  wrong).
- **Apply + build + restart**: `deploy/deploy.sh` — `prisma db push`,
  build into a fresh `.next` while the old build keeps serving, then
  `systemctl restart` (sub-second downtime).
- **Backups**: `familycall-backup.timer` runs `deploy/backup.sh` daily →
  `/var/backups/familycall`, 7-day retention.
