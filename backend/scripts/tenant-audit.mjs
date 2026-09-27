/**
 * Phase 22.2 — tenant-discipline audit (CLI, READ-ONLY).
 *
 * Scans the manifest of tenant-relevant backend files and reports every
 * query site that does not (yet) carry a workspace filter. Nothing is
 * written; nothing touches the database; it can be run against any checkout
 * at any time, including against a deployed build's source.
 *
 * The output is a STATUS REPORT. At the end of Phase 22.2 every
 * operational/identity query was EXPECTED to be unscoped; Phase 22.3 flipped
 * the manifest so each file carries `expected: 'scoped'` (except the
 * token-validated invitation controller, `partly-scoped`), and this tool now
 * fails the run when a scoped file regresses (use `--strict`, which is the
 * Phase 22.3 gate: exit 0 only when zero scoped query sites are unscoped).
 *
 * Usage (from backend/):
 *   node scripts/tenant-audit.mjs
 *   node scripts/tenant-audit.mjs --strict     # exit 1 on any not-yet-scoped query
 *   node scripts/tenant-audit.mjs --json       # machine-readable
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_MANIFEST, scanSource, groupFindings } from './lib/tenantAudit.mjs';

const BACKEND_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const strict = process.argv.includes('--strict');
const asJson = process.argv.includes('--json');

const results = [];
for (const entry of SCOPE_MANIFEST) {
  const abs = path.join(BACKEND_DIR, entry.file);
  if (!fs.existsSync(abs)) {
    results.push({ ...entry, missing: true, querySites: 0, findings: [] });
    continue;
  }
  const scan = scanSource(fs.readFileSync(abs, 'utf8'), { file: entry.file });
  results.push({ ...entry, ...scan });
}

const findings = results.flatMap((r) => r.findings || []);
const byTier = results.reduce((acc, r) => {
  acc[r.tier] = acc[r.tier] || { files: 0, querySites: 0, findings: 0 };
  acc[r.tier].files += 1;
  acc[r.tier].querySites += r.querySites;
  acc[r.tier].findings += (r.findings || []).length;
  return acc;
}, {});

// A file the plan says should be SCOPED but still has unscoped queries is a
// real regression; everything else is expected work-in-progress today.
const regressions = results.filter(
  (r) => r.expected === 'scoped' && (r.findings || []).length > 0
);
const missing = results.filter((r) => r.missing);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        phase: '22.3',
        scanned: results.length,
        querySites: results.reduce((a, r) => a + r.querySites, 0),
        findings: findings.length,
        regressions: regressions.map((r) => r.file),
        missing: missing.map((r) => r.file),
        byTier,
        details: results.map((r) => ({
          file: r.file,
          tier: r.tier,
          expected: r.expected,
          querySites: r.querySites,
          findings: (r.findings || []).length,
        })),
      },
      null,
      2
    )
  );
} else {
  console.log('PHASE 22.3 — TENANT DISCIPLINE AUDIT (read-only, heuristic)');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`Files scanned: ${results.length}   query sites: ${results.reduce((a, r) => a + r.querySites, 0)}   not-yet-scoped: ${findings.length}`);
  console.log('');
  for (const [tier, s] of Object.entries(byTier)) {
    console.log(`  ${tier.padEnd(11)} files ${String(s.files).padStart(2)}   query sites ${String(s.querySites).padStart(3)}   not-yet-scoped ${String(s.findings).padStart(3)}`);
  }
  console.log('');
  console.log('Per file');
  for (const r of results) {
    const flag = r.missing ? 'MISSING' : `${(r.findings || []).length} unscoped`;
    console.log(`  [${r.tier.padEnd(10)}] ${r.file.padEnd(46)} ${flag}  (expect: ${r.expected}, sites: ${r.querySites})`);
  }
  if (findings.length) {
    console.log('\nQuery sites without a workspace filter (Phase 22.3 work queue)');
    for (const g of groupFindings(findings)) {
      console.log(`  ${g.file}`);
      for (const f of g.items) console.log(`    L${f.line}  ${f.call}`);
    }
  }
  console.log('\nNOTE: ownership scoping (customerId / req.user) is independent and already');
  console.log('      enforced in most of these controllers — this report only tracks the');
  console.log('      WORKSPACE dimension. Isolation is NOT complete until Phase 22.5.');
}

if (missing.length) {
  console.error(`\n[tenant-audit] manifest file(s) missing: ${missing.map((m) => m.file).join(', ')}`);
  process.exit(1);
}
if (strict && regressions.length) {
  console.error(`\n[tenant-audit] STRICT: expected-scoped file(s) with unscoped queries: ${regressions.map((r) => r.file).join(', ')}`);
  process.exit(1);
}
