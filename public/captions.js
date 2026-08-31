/** Renders caption segments; interim text is replaced in place until the segment is final. */
export class Captions {
  constructor(el, maxLines = 12, fadeMs = 20_000) {
    this.el = el;
    this.max = maxLines;
    this.fadeMs = fadeMs; // a bubble fades out this long after its last update
    this.self = null;
    this.lines = new Map();
    this.dead = new Set(); // keys deleted by the user; late updates must not resurrect them
    this.onCopy = null; // (text) => void, set by the app
  }

  setSelf(id) {
    this.self = id;
  }

  clear() {
    for (const line of this.el.children) clearTimeout(line._fadeTimer);
    this.el.textContent = '';
    this.lines.clear();
    this.dead.clear();
  }

  _drop(line) {
    clearTimeout(line._fadeTimer);
    for (const [k, v] of this.lines) if (v === line) this.lines.delete(k);
    line.remove();
  }

  _scheduleFade(line) {
    clearTimeout(line._fadeTimer);
    line.classList.remove('fadeout');
    line._fadeTimer = setTimeout(() => {
      line.classList.add('fadeout'); // CSS transitions to opacity 0 over 10s …
      line._fadeTimer = setTimeout(() => this._drop(line), 10_500); // … then remove
    }, this.fadeMs);
  }

  /** Show the delete button (on the side facing the center of the screen). */
  _arm(line) {
    if (line.querySelector('.del')) return;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const [k, v] of this.lines) if (v === line) this.dead.add(k);
      this._drop(line);
    });
    if (line.classList.contains('cap-self')) line.prepend(del);
    else line.append(del);
  }

  _disarm(line) {
    line.querySelector('.del')?.remove();
  }

  /** Tap = copy; drag toward the center = reveal a delete button. */
  _attachGestures(line) {
    let startX = 0;
    let dx = 0;
    let dragging = false;
    line.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.del')) return;
      startX = e.clientX;
      dx = 0;
      dragging = true;
      line.setPointerCapture?.(e.pointerId);
      this._scheduleFade(line); // keep the bubble alive while it is being handled
    });
    line.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dx = e.clientX - startX;
      // Only slide toward the center: right for left-aligned bubbles, left for right-aligned.
      const toCenter = line.classList.contains('cap-self') ? Math.min(0, dx) : Math.max(0, dx);
      line.style.transform = toCenter ? `translateX(${Math.max(-80, Math.min(80, toCenter))}px)` : '';
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      line.style.transform = '';
      const toCenter = line.classList.contains('cap-self') ? -dx : dx;
      if (toCenter > 40) this._arm(line);
      else if (Math.abs(dx) < 8) {
        if (line.querySelector('.del')) this._disarm(line);
        else this.onCopy?.(line.querySelector('.txt').textContent);
      }
    };
    line.addEventListener('pointerup', end);
    line.addEventListener('pointercancel', () => {
      dragging = false;
      line.style.transform = '';
    });
  }

  update({ speaker, seg, text, final }) {
    const key = `${speaker}:${seg}`;
    if (this.dead.has(key)) return;
    let line = this.lines.get(key);
    if (!line) {
      // Direction is shown by alignment alone: incoming on the left, outgoing on the right.
      line = document.createElement('div');
      line.className = 'cap ' + (speaker === this.self ? 'cap-self' : 'cap-peer');
      line.dataset.speaker = speaker;
      const txt = document.createElement('span');
      txt.className = 'txt';
      line.append(txt);
      this._attachGestures(line);
      this.el.appendChild(line);
      this.lines.set(key, line);
      while (this.el.children.length > this.max) this._drop(this.el.firstElementChild);
    }
    line.querySelector('.txt').textContent = text;
    line.classList.toggle('interim', !final);
    // Final lines stay in the map: the server may amend a finalized caption
    // (late punctuation); eviction and fade-out prune the map via _drop.
    this._scheduleFade(line);
    this.el.scrollTop = this.el.scrollHeight;
  }
}
