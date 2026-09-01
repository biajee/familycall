/** Room bookkeeping. Pure logic, no I/O, so it is unit-testable. */
export const MAX_PEERS = 2;
export const LANGS = ['zh-CN', 'en-US', 'auto'];

export class Rooms {
  constructor() {
    this.rooms = new Map();
  }

  get(roomId) {
    return this.rooms.get(roomId);
  }

  /** Adds a peer. Returns {ok, room, others} or {ok:false, code}. */
  join(roomId, peer) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { id: roomId, peers: new Map(), createdAt: Date.now() };
      this.rooms.set(roomId, room);
    }
    if (room.peers.has(peer.id)) return { ok: false, code: 'already_joined' };
    if (room.peers.size >= MAX_PEERS) return { ok: false, code: 'room_full' };
    // Perfect negotiation: the peer that was already in the room is "impolite",
    // every later joiner is "polite". This keeps the roles distinct at all times.
    peer.polite = room.peers.size > 0;
    peer.joinedAt = Date.now();
    room.peers.set(peer.id, peer);
    return { ok: true, room, others: this.others(roomId, peer.id) };
  }

  /** Removes a peer. Returns the peers that remain in the room. */
  leave(roomId, peerId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    room.peers.delete(peerId);
    const remaining = [...room.peers.values()];
    if (remaining.length === 0) this.rooms.delete(roomId);
    return remaining;
  }

  others(roomId, peerId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.peers.values()].filter((p) => p.id !== peerId);
  }

  members(roomId) {
    const room = this.rooms.get(roomId);
    return room ? [...room.peers.values()] : [];
  }
}

export function publicPeer(p) {
  return { id: p.id, name: p.name, lang: p.lang, captions: p.sttChoice !== 'off' };
}

export function sanitizeName(n) {
  const s = String(n ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32);
  return s || 'Guest';
}

export function sanitizeRoom(r) {
  return String(r ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
}

export function sanitizeLang(l) {
  return LANGS.includes(l) ? l : 'zh-CN';
}
