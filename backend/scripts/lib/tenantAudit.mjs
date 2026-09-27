/**
 * Phase 22.2 — tenant-discipline audit (pure, unit-testable core).
 *
 * WHY: tenant isolation is a property of EVERY query, and it degrades
 * silently — one new `Order.find({})` in a controller and the platform is
 * cross-tenant again. Review can catch that once; a repeatable scanner
 * catches it every time.
 *
 * This module deliberately does NO file IO and NO database work so it can be
 * exercised against synthetic source snippets (see tenant-core-smoke.mjs).
 * `scripts/tenant-audit.mjs` is the thin CLI that feeds it real files.
 *
 * THE HEURISTIC (documented, report-only):
 *   · a "query site" is a call to one of the known Mongoose query methods;
 *   · a call is considered workspace-aware when the text immediately inside
 *     (default 400 characters, the filter object always comes first) mentions
 *     one of the tenancy helpers: `workspaceId`, `workspaceFilter(`,
 *     `getWorkspaceId(`, `assertWorkspaceMember(`, `requireWorkspace`,
 *     `workspaceScope(`, `requestScope(`;
 *   · anything else is reported as an unscoped query — INCLUDING calls that
 *     are legitimately ownership-scoped (customerId/req.user), because the
 *     audit's job is to enumerate what still needs the workspace dimension,
 *     not to approve it. Every finding is therefore phrased as
 *     "not yet tenant-scoped", never as "a bug".
 *
 * Heuristics can produce false positives; they must never be used to claim
 * isolation is complete. The manifest below also records what is EXPECTED to
 * be unscoped today so a run is diffable across phases.
 */

/** Mongoose query/write methods whose results are tenant-relevant. */
export const QUERY_METHODS = [
  'find',
  'findOne',
  'findById',
  'countDocuments',
  'aggregate',
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'deleteOne',
  'deleteMany',
  'insertMany',
  'bulkWrite',
  'distinct',
];

const QUERY_RE = new RegExp(`\\.(?:${QUERY_METHODS.join('|')})\\s*\\(`, 'g');

/** Text that marks a call site as workspace-aware.
 *  Phase 22.3 added `workspaceScope(`/`requestScope(` — the two query-filter
 *  helpers every scoped controller spreads into its reads — so a file using
 *  them is recognised exactly like one writing `{ workspaceId }` inline. */
export const TENANCY_RE =
  /workspaceId|workspaceFilter\s*\(|getWorkspaceId\s*\(|assertWorkspaceMember\s*\(|requireWorkspace|workspaceScope\s*\(|requestScope\s*\(/;

/** Explicit "this is known-unscoped for now" marker. */
export const UNSCOPED_MARKER_RE = /PHASE-22\.\d+:\s*NOT YET TENANT-SCOPED/;

export const DEFAULT_LOOKAHEAD = 400;

/**
 * Scan one source string for query sites that do not carry a tenant filter.
 *
 * @param {string} source            file contents
 * @param {object} [opts]
 * @param {number} [opts.lookahead]  characters scanned after a call for tenancy markers
 * @param {string} [opts.file]       label attached to each finding
 * @returns {{querySites:number, tenancySites:number, findings:Array, markedUnscoped:boolean}}
 */
export function scanSource(source, { lookahead = DEFAULT_LOOKAHEAD, file = '<source>' } = {}) {
  const text = String(source);
  const findings = [];
  let querySites = 0;
  const tenancyMatches = [...text.matchAll(new RegExp(TENANCY_RE, 'g'))];
  const tenancySites = tenancyMatches.length;

  const re = new RegExp(QUERY_RE);
  let m;
  while ((m = re.exec(text)) !== null) {
    querySites += 1;
    const window = text.slice(m.index, m.index + lookahead);
    if (TENANCY_RE.test(window)) continue;
    // Report line number (1-based) for a stable, diffable output.
    const line = text.slice(0, m.index).split('\n').length;
    findings.push({
      file,
      line,
      call: m[0].replace(/\s*\($/, '()'),
      reason: 'no workspace filter within the call window',
    });
  }

  return {
    file,
    querySites,
    tenancySites,
    findings,
    markedUnscoped: UNSCOPED_MARKER_RE.test(text),
  };
}

/**
 * Scan several sources.
 * @param {Array<{file:string, source:string}>} entries
 */
export function scanAll(entries, opts = {}) {
  const results = entries.map((e) => scanSource(e.source, { ...opts, file: e.file }));
  return {
    results,
    findings: results.flatMap((r) => r.findings),
    querySites: results.reduce((a, r) => a + r.querySites, 0),
    tenancySites: results.reduce((a, r) => a + r.tenancySites, 0),
  };
}

/**
 * The Phase 22 scope manifest: which backend files carry tenant-relevant
 * queries, and their EXPECTED state at the end of Phase 22.3.
 *
 *  tier 'operational'  — staff-facing data (workspace-filtered by 22.3);
 *  tier 'customer'     — customer-facing data (workspace dimension added in
 *                        Phase 22.3 alongside ownership checks);
 *  tier 'identity'     — user/staff/directory reads (workspace-filtered in
 *                        22.3; see docs/MULTI-TENANT.md).
 *
 * `expected: 'scoped'` means EVERY query site in the file must carry a
 * tenancy marker — `--strict` fails the run otherwise, so a new unscoped
 * query in these files is a regression caught on the next audit.
 *
 * `expected: 'partly-scoped'` marks files whose remaining unscoped sites are
 * DELIBERATE. Today that is only `invitationController.js`: its endpoints are
 * public and keyed by a 256-bit token, so there is no caller identity to
 * derive a workspaceId from — every lookup is authorised by token possession
 * and the invitation's own (server-set) binding instead.
 */
export const SCOPE_MANIFEST = [
  { file: 'controllers/productController.js', tier: 'operational', expected: 'scoped' },
  { file: 'controllers/collectionController.js', tier: 'operational', expected: 'scoped' },
  { file: 'controllers/orderController.js', tier: 'operational', expected: 'scoped' },
  { file: 'controllers/inventoryController.js', tier: 'operational', expected: 'scoped' },
  { file: 'controllers/customerController.js', tier: 'operational', expected: 'scoped' },
  { file: 'controllers/conversationController.js', tier: 'customer', expected: 'scoped' },
  { file: 'controllers/customRequestController.js', tier: 'customer', expected: 'scoped' },
  { file: 'controllers/settingsController.js', tier: 'operational', expected: 'scoped' },
  { file: 'controllers/analyticsController.js', tier: 'operational', expected: 'scoped' },
  { file: 'controllers/notificationController.js', tier: 'identity', expected: 'scoped' },
  { file: 'controllers/adminUserController.js', tier: 'identity', expected: 'scoped' },
  { file: 'controllers/staffController.js', tier: 'identity', expected: 'scoped' },
  { file: 'controllers/staffInvitationController.js', tier: 'identity', expected: 'scoped' },
  { file: 'controllers/invitationController.js', tier: 'identity', expected: 'partly-scoped' },
  { file: 'services/orderService.js', tier: 'operational', expected: 'scoped' },
  { file: 'services/inventoryService.js', tier: 'operational', expected: 'scoped' },
  { file: 'services/analyticsService.js', tier: 'operational', expected: 'scoped' },
  { file: 'services/conversationService.js', tier: 'customer', expected: 'scoped' },
];

/** Tenancy-aware CALLS (what "scoped" looks like) — used by assertions. */
export function isTenantAware(snippet) {
  return TENANCY_RE.test(String(snippet || ''));
}

/** Group findings by file for a compact CLI report. */
export function groupFindings(findings) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  return [...byFile.entries()].map(([file, items]) => ({ file, items }));
}
