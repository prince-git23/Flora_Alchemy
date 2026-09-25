/**
 * Phase 20.6 — environment safety guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * `backend/.env` is a single, untracked file that normally holds the PRODUCTION
 * connection string (that is how the deployed instance is configured locally
 * today). Nothing in the codebase stopped an ordinary local command from
 * resolving to that same database, so `npm run seed`, `npm run dev` or
 * `node scripts/backfill-inventory.mjs --purge-orphans` could silently mutate
 * live production records — including re-creating the demo staff account.
 *
 * This module makes the target database an EXPLICIT, CHECKED fact:
 *
 *   · the effective database name is derived from the URI (never assumed)
 *   · a database is only treated as safe-to-write when it is unmistakably
 *     disposable (its name carries a `test`/`qa`/`dev`/`smoke`/`sandbox`
 *     marker) or it lives on a local Mongo instance
 *   · an explicitly protected database name ALWAYS fails closed — no override;
 *     production (`NODE_ENV=production`) fails closed for anything that is not
 *     already disposable or local
 *   · the database identity is the primary signal, deliberately: a stale
 *     NODE_ENV must not be able to authorise a live database, and must not be
 *     able to block a genuinely disposable one
 *   · anything else requires a deliberate, exact-name confirmation
 *     (`CONFIRM_DATABASE_UNSAFE_OPERATION=<database name>`), so an accidental
 *     copy-paste can never authorise it
 *
 * It is intentionally dependency-free and side-effect-free so any script,
 * seed or server boot path can import it safely.
 */

const DISPOSABLE_MARKERS = ['test', 'qa', 'dev', 'smoke', 'sandbox'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

export class EnvironmentSafetyError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EnvironmentSafetyError';
    this.code = 'UNSAFE_DATABASE';
    this.database = detail.database || '';
    this.operation = detail.operation || '';
    this.reason = detail.reason || '';
  }
}

/**
 * Extract the effective database name from a MongoDB URI.
 * Handles both `mongodb+srv://…/db?opts` (URL-parseable) and the
 * `mongodb://host:port/db` form, and returns '' when it cannot be determined
 * — callers must treat '' as UNSAFE, never as "probably fine".
 */
export function dbNameFromUri(uri = process.env.MONGO_URI) {
  if (!uri) return '';
  const raw = String(uri);
  const withoutQuery = raw.split('?')[0];
  const afterHost = withoutQuery.replace(/^mongodb(\+srv)?:\/\//i, '');
  const slash = afterHost.indexOf('/');
  if (slash === -1) return '';
  return decodeURIComponent(afterHost.slice(slash + 1)).trim();
}

function hostFromUri(uri = process.env.MONGO_URI) {
  const raw = String(uri || '');
  const afterScheme = raw.replace(/^mongodb(\+srv)?:\/\//i, '');
  const authority = afterScheme.split('/')[0];
  // strip user:pass@ — credentials must never be parsed further than needed
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  return hostPart.split(':')[0].toLowerCase();
}

/** Database names that must never receive destructive or fixture writes. */
export function protectedDbNames() {
  return String(process.env.PRODUCTION_DB_NAMES || process.env.PRODUCTION_DB_NAME || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isDisposableDbName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (protectedDbNames().some((p) => p.toLowerCase() === n)) return false;
  return DISPOSABLE_MARKERS.some((marker) => n.includes(marker));
}

/**
 * Classify the database a URI points at. `disposable` means "safe to run
 * destructive or fixture-creating work against".
 */
export function classifyDatabase(uri = process.env.MONGO_URI) {
  const dbName = dbNameFromUri(uri);
  const host = hostFromUri(uri);
  const localHost = LOCAL_HOSTS.includes(host);
  const nameProtected = protectedDbNames().some((p) => p.toLowerCase() === String(dbName).toLowerCase());
  const nodeEnv = process.env.NODE_ENV || 'development';
  return {
    dbName,
    host,
    localHost,
    nodeEnv,
    isProductionEnv: nodeEnv === 'production',
    nameProtected,
    disposable: (isDisposableDbName(dbName) || localHost) && !nameProtected,
    // Deliberate, exact-name confirmation for an intentional one-off.
    confirmed: !!dbName && String(process.env.CONFIRM_DATABASE_UNSAFE_OPERATION || '') === dbName,
  };
}

/** One-line, credential-free description for logs. */
export function describeDatabase(uri = process.env.MONGO_URI) {
  const info = classifyDatabase(uri);
  const cls = info.disposable ? 'disposable' : 'PROTECTED';
  return `env=${info.nodeEnv} db=${info.dbName || '<unknown>'} host=${info.localHost ? 'local' : 'remote'} class=${cls}`;
}

/**
 * Fail closed unless the target database is safe for this operation.
 *
 * @param {string} uri          the connection string actually about to be used
 * @param {string} operation    human label, e.g. 'seed fixtures'
 * @param {object} [opts]
 * @param {boolean} [opts.requireDisposable=true] false for read-only work
 * @returns {ReturnType<typeof classifyDatabase>}
 */
export function assertSafeDatabase(uri, operation, { requireDisposable = true } = {}) {
  const info = classifyDatabase(uri);

  if (!requireDisposable) return info;

  const deny = (reason, extra = '') => {
    throw new EnvironmentSafetyError(
      [
        `Refusing to ${operation}: the configured database is not a disposable one.`,
        `  database : ${info.dbName || '<could not be determined>'}`,
        `  host     : ${info.host || '<unknown>'}${info.localHost ? ' (local)' : ''}`,
        `  NODE_ENV : ${info.nodeEnv}`,
        `  reason   : ${reason}`,
        extra,
        'Fix: point MONGO_URI at a development/test database (name containing test/qa/dev/smoke),',
        'or — for a deliberate one-off — set CONFIRM_DATABASE_UNSAFE_OPERATION to the exact',
        'database name above and re-run. Never do this against production data.',
      ].join('\n'),
      { database: info.dbName, operation, reason }
    );
  };

  // Order matters. The DATABASE IDENTITY is the primary signal, because a
  // stale NODE_ENV (the shipped backend/.env sets NODE_ENV=production even on a
  // developer machine) must not be able to block legitimate work against a
  // genuinely disposable test database — while the opposite mistake, writing
  // to a live database, must always be refused.
  if (!info.dbName) deny('the database name could not be determined from MONGO_URI');
  if (info.nameProtected) deny('the database name is listed in PRODUCTION_DB_NAMES');
  // Unmistakably disposable by name, or a local instance: safe to write.
  if (info.disposable) return info;
  if (info.isProductionEnv) deny('NODE_ENV=production and the database is not disposable');
  if (!info.confirmed) {
    deny('the database name has no test/qa/dev/smoke marker and is not a local instance');
  }
  return info;
}

/**
 * Fixture credentials (the demo customer password and the demo handler
 * account) are a development convenience. Creating them in a non-disposable
 * database is exactly the production staff-account risk this phase removes,
 * so this is checked independently of any general seed guard.
 */
export function assertFixtureAccountsAllowed(uri = process.env.MONGO_URI, operation = 'create demo fixture accounts') {
  const info = describeDatabase(uri);
  if (!isDisposableDbName(dbNameFromUri(uri))) {
    throw new EnvironmentSafetyError(
      [
        `Refusing to ${operation}: demo credentials may only exist in a disposable database.`,
        `  ${info}`,
        'Demo accounts are quick-fill conveniences for local/QA work. Provision real staff',
        'accounts explicitly instead of seeding them into a live database.',
      ].join('\n'),
      { database: dbNameFromUri(uri), operation, reason: 'demo credentials in a non-disposable database' }
    );
  }
  return true;
}
