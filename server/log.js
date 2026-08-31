const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger(level = 'info', prefix = '') {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, args) => {
    if (LEVELS[lvl] < min) return;
    const ts = new Date().toISOString();
    const fn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    fn(`${ts} ${lvl.toUpperCase().padEnd(5)}${prefix ? ' ' + prefix : ''}`, ...args);
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    child: (p) => createLogger(level, prefix ? `${prefix} ${p}` : p),
  };
}
