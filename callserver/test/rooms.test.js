import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rooms, sanitizeName, sanitizeRoom, sanitizeLang, MAX_PEERS } from '../server/rooms.js';

test('two peers can join, the third is rejected', () => {
  const rooms = new Rooms();
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };
  const ra = rooms.join('fam', a);
  assert.equal(ra.ok, true);
  assert.equal(a.polite, false, 'first joiner is impolite');
  assert.deepEqual(ra.others, []);
  const rb = rooms.join('fam', b);
  assert.equal(rb.ok, true);
  assert.equal(b.polite, true, 'second joiner is polite');
  assert.deepEqual(rb.others.map((p) => p.id), ['a']);
  const rc = rooms.join('fam', c);
  assert.equal(rc.ok, false);
  assert.equal(rc.code, 'room_full');
  assert.equal(rooms.members('fam').length, MAX_PEERS);
});

test('leaving frees the slot and empty rooms are deleted', () => {
  const rooms = new Rooms();
  rooms.join('r', { id: 'a' });
  rooms.join('r', { id: 'b' });
  assert.deepEqual(rooms.leave('r', 'a').map((p) => p.id), ['b']);
  const c = { id: 'c' };
  assert.equal(rooms.join('r', c).ok, true);
  assert.equal(c.polite, true);
  rooms.leave('r', 'b');
  rooms.leave('r', 'c');
  assert.equal(rooms.get('r'), undefined);
  assert.deepEqual(rooms.leave('r', 'zzz'), []);
});

test('same id cannot join twice', () => {
  const rooms = new Rooms();
  const a = { id: 'a' };
  assert.equal(rooms.join('r', a).ok, true);
  assert.equal(rooms.join('r', a).code, 'already_joined');
});

test('sanitizers', () => {
  assert.equal(sanitizeName('  爸爸 \n '), '爸爸');
  assert.equal(sanitizeName(''), 'Guest');
  assert.equal(sanitizeName('x'.repeat(50)).length, 32);
  assert.equal(sanitizeRoom(' Family-Room_1! '), 'family-room_1');
  assert.equal(sanitizeRoom('###'), '');
  assert.equal(sanitizeLang('en-US'), 'en-US');
  assert.equal(sanitizeLang('auto'), 'auto');
  assert.equal(sanitizeLang('fr'), 'zh-CN');
});
