/**
 * PRIVATE MEDIA ROOT — the single place that decides WHERE reference media and
 * 3D media live, and whether that location can actually be written.
 *
 * Why this module exists
 * ----------------------
 * The two studios each grew their own root resolution, and they disagreed:
 *
 *   · `referenceAssetStorage` anchored its default to `__dirname` (correct, but
 *     it silently lived inside the deploy directory, so every redeploy erased
 *     the files);
 *   · `3dAssetStorage` used `path.resolve(process.env.UPLOAD_DIR || 'backend/uploads', '3d-media')`,
 *     which is relative to the PROCESS CWD — started from `backend/` (which is
 *     exactly what `render.yaml` does) it produced `backend/backend/uploads/3d-media`,
 *     a path no document mentions and no `.gitignore` rule covers.
 *
 * Both are now resolved here, absolutely, with one rule: **configuration wins,
 * the app directory is only a development fallback**. In production a root
 * inside the app directory is reported as NOT durable rather than pretended to
 * be safe (see `describeRoot`), because the platform replaces that directory on
 * every deploy.
 *
 * Error translation
 * -----------------
 * A raw `fs` failure used to reach the client as
 * `500 INTERNAL_ERROR "An unexpected server error occurred."`, which is
 * indistinguishable from any other server fault and told the administrator
 * nothing. Every write here is translated into an `ApiError` carrying a
 * specific code (`STORAGE_NOT_WRITABLE`, `STORAGE_FULL`, …). The client gets the
 * code and a safe sentence; the server log gets the syscall and path.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../middleware/errorMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `<repo>/backend` — the boundary that decides "inside the deploy tree". */
export const BACKEND_DIR = path.resolve(__dirname, '..');

/**
 * Resolve a private root.
 *
 * @param {string} envVar            the variable that may override it
 * @param {string} fallbackRelative  dev fallback, relative to `backend/`
 * @returns {string} absolute path (never CWD-dependent)
 */
export function resolvePrivateRoot(envVar, fallbackRelative) {
  const configured = String(process.env[envVar] || '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(BACKEND_DIR, fallbackRelative);
}

/** True when `target` is the app directory or lives inside it. */
export function isInsideAppTree(target) {
  const absolute = path.resolve(target);
  if (absolute === BACKEND_DIR) return true;
  const withSep = BACKEND_DIR.endsWith(path.sep) ? BACKEND_DIR : BACKEND_DIR + path.sep;
  return absolute.startsWith(withSep);
}

/**
 * Is this root expected to survive a redeploy?
 *
 * Not "is it writable" — an app-relative directory is writable and still wiped.
 * A root outside the app tree is assumed durable (a mounted disk or an object
 * store mount point); a root inside it is not, whatever the platform promises.
 */
export function isDurableRoot(target) {
  return !isInsideAppTree(target);
}

/** Translate a Node fs error into a typed, safe API error. */
export function toStorageError(err, { label = 'Private media' } = {}) {
  const code = err && err.code ? String(err.code) : '';
  const map = {
    EACCES: ['STORAGE_NOT_WRITABLE', 'The server cannot write to its private media directory.'],
    EPERM: ['STORAGE_NOT_WRITABLE', 'The server cannot write to its private media directory.'],
    EROFS: ['STORAGE_NOT_WRITABLE', 'The server cannot write to its private media directory.'],
    ENOENT: ['STORAGE_MISSING', 'The server private media directory is missing.'],
    ENOSPC: ['STORAGE_FULL', 'The server private media storage is full.'],
    EDQUOT: ['STORAGE_FULL', 'The server private media storage is full.'],
    EMFILE: ['STORAGE_EXHAUSTED', 'The server is handling too many files at once.'],
    ENFILE: ['STORAGE_EXHAUSTED', 'The server is handling too many files at once.'],
    EIO: ['STORAGE_UNAVAILABLE', 'The server private media storage returned an I/O error.'],
  };
  const [apiCode, sentence] = map[code] || [
    'STORAGE_UNAVAILABLE',
    'The server private media storage is unavailable.',
  ];
  // Server-side detail: the syscall and path are operationally useful and never
  // leave this process. The client only ever sees `sentence` + the code.
  console.error(
    `[private-media] ${label.toLowerCase()} write failed · code=${code || 'UNKNOWN'} syscall=${err?.syscall || '?'} path=${err?.path || '?'}`
  );
  return new ApiError(
    503,
    `${sentence} The upload was not stored — nothing was kept, so it is safe to retry. (${apiCode})`,
    apiCode
  );
}

/**
 * Create (if needed) and prove a directory is writable.
 *
 * The probe writes and removes a single empty file. It runs at the write
 * boundary — never at import time, so a deployment that does not use the
 * studios cannot fail to boot because of them.
 */
export async function assertWritableDir(dir, { label = 'Private media' } = {}) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    await fsp.writeFile(probe, '');
    await fsp.rm(probe, { force: true });
  } catch (err) {
    throw toStorageError(err, { label });
  }
  return dir;
}

/**
 * A NON-THROWING description for boot logs and health output.
 *
 * Used where a failure must be reported, not raised: the API must still boot
 * and still serve the storefront if the private media disk is unavailable — the
 * studios are a staff feature, not a dependency of browsing.
 *
 * `probe: false` skips the write probe and reports `writable: null`, which is
 * what a development or test boot uses: those runs would otherwise create real
 * directories in the working tree for a root they never write to. A root that
 * is CONFIGURED with its environment variable is always probed, and so is every
 * production boot.
 */
export async function describeRoot({ kind, root, envVar, probe = true }) {
  const info = {
    kind,
    configured: Boolean(String(process.env[envVar] || '').trim()),
    envVar,
    insideAppTree: isInsideAppTree(root),
    durable: isDurableRoot(root),
    checked: probe,
    // `null` means "not probed" — deliberately distinct from `false`, which means
    // "probed and refused". Reporting an unchecked root as unwritable would be
    // its own small lie.
    writable: probe ? false : null,
    errorCode: null,
  };
  if (!probe) return info;
  try {
    await fsp.mkdir(root, { recursive: true });
    const probePath = path.join(root, `.write-probe-${process.pid}-${Date.now()}`);
    await fsp.writeFile(probePath, '');
    await fsp.rm(probePath, { force: true });
    info.writable = true;
  } catch (err) {
    info.errorCode = (err && err.code) || 'UNKNOWN';
  }
  return info;
}

/** Free space in bytes for the filesystem holding `target`, or null. */
export async function freeSpace(target) {
  try {
    const stats = await fsp.statfs(target);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
