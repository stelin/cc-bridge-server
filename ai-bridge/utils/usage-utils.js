/**
 * Shared usage accumulation utilities for streaming token tracking.
 * Used by message-service.js and persistent-query-service.js.
 */

export const DEFAULT_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
};

/**
 * Merge usage data following CLI's nz6() logic.
 * - input_tokens, cache_*: only update if new value > 0 (preserve accumulated)
 * - output_tokens: use new value directly (incremental updates)
 */
export function mergeUsage(accumulated, newUsage) {
  if (!newUsage) return accumulated || { ...DEFAULT_USAGE };
  if (!accumulated) return { ...DEFAULT_USAGE, ...newUsage };
  return {
    input_tokens: newUsage.input_tokens > 0 ? newUsage.input_tokens : accumulated.input_tokens,
    cache_creation_input_tokens: newUsage.cache_creation_input_tokens > 0
      ? newUsage.cache_creation_input_tokens : accumulated.cache_creation_input_tokens,
    cache_read_input_tokens: newUsage.cache_read_input_tokens > 0
      ? newUsage.cache_read_input_tokens : accumulated.cache_read_input_tokens,
    output_tokens: newUsage.output_tokens ?? accumulated.output_tokens
  };
}

/**
 * Emit [USAGE] tag from accumulated usage data during streaming.
 * NOTE: Uses process.stdout.write for consistent buffering with other IPC messages.
 */
export function emitAccumulatedUsage(accumulated) {
  if (!accumulated) return;
  process.stdout.write('[USAGE] ' + JSON.stringify({
    input_tokens: accumulated.input_tokens || 0,
    output_tokens: accumulated.output_tokens || 0,
    cache_creation_input_tokens: accumulated.cache_creation_input_tokens || 0,
    cache_read_input_tokens: accumulated.cache_read_input_tokens || 0
  }) + '\n');
}

/**
 * Rough char→token estimate for the live "↓ N tokens" counter during streaming.
 *
 * <p>The API's authoritative {@code message_delta} usage is sparse — it usually
 * arrives only once near message end and is absent during the extended-thinking
 * phase — so the counter would otherwise sit still and only jump at the end.
 * We approximate from streamed text/thinking chars (~4 chars/token) so the
 * counter ticks live like the CLI; the real value reconciles at message_delta.
 */
export function estimateTokensFromChars(chars) {
  return Math.ceil((chars || 0) / 4);
}

/**
 * Emit a [USAGE] line whose output_tokens is the larger of the authoritative
 * accumulated value and the live char-based estimate, so the ticker never moves
 * backward. input/cache come from the authoritative accumulated usage.
 */
export function emitLiveUsage(accumulated, estimatedOutputTokens) {
  const acc = accumulated || DEFAULT_USAGE;
  const output = Math.max(acc.output_tokens || 0, estimatedOutputTokens || 0);
  process.stdout.write('[USAGE] ' + JSON.stringify({
    input_tokens: acc.input_tokens || 0,
    output_tokens: output,
    cache_creation_input_tokens: acc.cache_creation_input_tokens || 0,
    cache_read_input_tokens: acc.cache_read_input_tokens || 0
  }) + '\n');
}
