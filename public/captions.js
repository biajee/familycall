/** Renders caption segments; interim text is replaced in place until the segment is final. */
export class Captions {
  constructor(el, maxLines = 12) {
    this.el = el;
    this.max = maxLines;
    this.self = null;
    this.lines = new Map();
  }

  setSelf(id) {
    this.self = id;
  }

  clear() {
    this.el.textContent = '';
    this.lines.clear();
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
      while (this.el.children.length > this.max) {
        const first = this.el.firstElementChild;
        for (const [k, v] of this.lines) if (v === first) this.lines.delete(k);
        first.remove();
      }
    }
    line.querySelector('.txt').textContent = text;
    line.classList.toggle('interim', !final);
    if (final) this.lines.delete(key);
    this.el.scrollTop = this.el.scrollHeight;
  }
}
