/**
 * Path safety helpers for /history endpoints.
 * All resolved paths must stay within an explicit root directory.
 */
import path from 'node:path';

export function resolveSafe(root, relPath) {
  if (relPath === undefined || relPath === null) throw httpError(400, 'missing path');
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    throw httpError(400, 'invalid path');
  }
  if (relPath.split(/[/\\]/).includes('..')) {
    throw httpError(403, 'parent dir not allowed');
  }

  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, relPath);

  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw httpError(403, 'path escape detected');
  }
  return resolved;
}

export function base64UrlDecode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) {
    throw httpError(400, 'invalid encoded path');
  }
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    throw httpError(400, 'malformed base64url');
  }
}

export function base64UrlEncode(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
