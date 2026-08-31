/** Renders caption segments; interim text is replaced in place until the segment is final. */
export class Captions {
  constructor(el, maxLines = 12, fadeMs = 20_000) {
    this.el = el;
    this.max = maxLines;
    this.fadeMs = fadeMs; // a bubble fades out this long after its last update
    this.self = null;
    this.lines = new Map();
  }

  setSelf(id) {
    this.self = id;
  }

  clear() {
    for (const line of this.el.children) clearTimeout(line._fadeTimer);
    this.el.textContent = '';
    this.lines.clear();
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

  update({ speaker, seg, text, final }) {
    const key = `${speaker}:${seg}`;
    let line = this.lines.get(key);
    if (!line) {
      // Direction is shown by alignment alone: incoming on the left, outgoing on the right.
      line = document.createElement('div');
      line.className = 'cap ' + (speaker === this.self ? 'cap-self' : 'cap-peer');
      line.dataset.speaker = speaker;
      const txt = document.createElement('span');
      txt.className = 'txt';
      line.append(txt);
      this.el.appendChild(line);
      this.lines.set(key, line);
      while (this.el.children.length > this.max) this._drop(this.el.firstElementChild);
    }
    line.querySelector('.txt').textContent = text;
    line.classList.toggle('interim', !final);
    if (final) this.lines.delete(key);
    this._scheduleFade(line);
    this.el.scrollTop = this.el.scrollHeight;
  }
}
