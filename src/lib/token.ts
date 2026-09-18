import crypto from "crypto";

// A room's slug IS its shared secret (see prisma/schema.prisma's comment
// on Room.slug) — the call server treats any valid slug as authorization
// to join, so this needs to be unguessable, not just unique. Lowercased
// base32-ish alphabet (no padding, no ambiguous characters) keeps it
// comfortable to read aloud or copy into a chat app.
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateRoomSlug(): string {
  const bytes = crypto.randomBytes(16);
  let out = "";
  for (const b of bytes) out += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return out.slice(0, 20);
}
