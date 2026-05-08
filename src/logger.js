/**
 * Minimal level-based logger. Writes to stderr to keep stdout clean.
 *
 * Verbose mode (detailed request / push payload logs) turns on when ANY of:
 *   - CLI flag `--verbose` or `-v` (e.g. `npm start -- --verbose`)
 *   - env `VERBOSE=1`
 *   - env `LOG_LEVEL=debug`
 */
const VERBOSE = process.env.VERBOSE === '1'
  || process.argv.includes('--verbose')
  || process.argv.includes('-v')
  || (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';

const LEVEL = (process.env.LOG_LEVEL || (VERBOSE ? 'debug' : 'info')).toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESHOLD = LEVELS[LEVEL] ?? LEVELS.info;

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function localTimestamp() {
  const d = new Date();
  return `${pad(d.getFullYear() % 100)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function log(level, ...args) {
  if (LEVELS[level] < THRESHOLD) return;
  // eslint-disable-next-line no-console
  console.error(`[${localTimestamp()}][${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug:   (...a) => log('debug', ...a),
  info:    (...a) => log('info',  ...a),
  warn:    (...a) => log('warn',  ...a),
  error:   (...a) => log('error', ...a),
  verbose: (...a) => { if (VERBOSE) log('debug', '[V]', ...a); },
  isVerbose: () => VERBOSE,
};
