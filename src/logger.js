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

function log(level, ...args) {
  if (LEVELS[level] < THRESHOLD) return;
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.error(`[${ts}][${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug:   (...a) => log('debug', ...a),
  info:    (...a) => log('info',  ...a),
  warn:    (...a) => log('warn',  ...a),
  error:   (...a) => log('error', ...a),
  verbose: (...a) => { if (VERBOSE) log('debug', '[V]', ...a); },
  isVerbose: () => VERBOSE,
};
