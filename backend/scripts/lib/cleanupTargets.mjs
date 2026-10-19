/**
 * cleanupTargets — the PURE decision of which databases a cleanup run may
 * delete. Extracted from `scripts/db-footprint.mjs` so it can be unit-tested
 * without a cluster (see `scripts/environment-guard-smoke.mjs`).
 *
 * WHY THIS EXISTS (October 2026 incident review)
 * ---------------------------------------------
 * Name-based markers alone (`test`/`qa`/`dev`/`smoke`/`sandbox`) are a weak
 * signal for DELETION: a remote development database such as `flora_alchemy_dev`
 * lives on the SAME cluster as production and holds real work. It looks
 * "disposable" by name, so a cleanup run pointed at that cluster could remove
 * it. The rule implemented here is deliberately stricter than the one used for
 * CREATING test databases:
 *
 *   · a target must be EXPLICITLY verified as disposable, which means
 *     — it matches the naming pattern this repository's suites actually create
 *       (`Flora-Alchemy-Test-*`), or
 *     — the operator listed the exact name on the command line (`--allow=<n>`);
 *   · protected names (production and the shared development database) are
 *     never deletable, with or without `--allow`;
 *   · the database the caller is currently connected to is never deletable;
 *   · anything unknown is kept.
 *
 * A deletion tool must fail towards keeping data.
 */

/** The only pattern whose databases this repo creates automatically. */
export const SUITE_DB_PATTERN = /^flora-alchemy-test-/i;

/** Names that must never be deleted by any cleanup path (canonical casing). */
export const ALWAYS_PROTECTED = ['Flora-Alchemy', 'flora_alchemy_dev'];

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Which databases may be dropped.
 *
 * @param {Array<{name: string, collections?: number}>} databases  inventory
 * @param {object} opts
 * @param {Set<string>|string[]} [opts.keep]         names to keep regardless
 * @param {string} [opts.connectedDb]                the configured database
 * @param {string[]} [opts.protectedNames]           extra protected names
 * @param {Set<string>|string[]} [opts.allow]        operator-verified names
 * @returns {{ droppable: string[], kept: Array<{name: string, reason: string}> }}
 */
export function selectCleanupTargets(databases, opts = {}) {
  const toSet = (v) => new Set((v instanceof Set ? [...v] : (v || [])).map(norm).filter(Boolean));
  const keep = toSet(opts.keep);
  const allow = toSet(opts.allow);
  const connected = norm(opts.connectedDb);
  const protectedNames = new Set(
    [...ALWAYS_PROTECTED, ...(opts.protectedNames || [])].map(norm).filter(Boolean)
  );

  const droppable = [];
  const kept = [];

  for (const entry of databases || []) {
    const name = String(entry?.name || '');
    const n = norm(name);
    if (!n) continue;
    if (protectedNames.has(n)) { kept.push({ name, reason: 'protected name' }); continue; }
    if (n === connected) { kept.push({ name, reason: 'currently configured database' }); continue; }
    if (keep.has(n)) { kept.push({ name, reason: 'keep list' }); continue; }
    if (SUITE_DB_PATTERN.test(name)) { droppable.push(name); continue; }
    if (allow.has(n)) { droppable.push(name); continue; }
    kept.push({
      name,
      reason: SUITE_DB_PATTERN.test(name)
        ? 'suite pattern'
        : 'not explicitly verified as disposable (no --allow)',
    });
  }

  return { droppable, kept };
}
