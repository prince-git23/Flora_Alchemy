/**
 * production-probe — a READ-ONLY contract check against a deployed API.
 *
 * WHY
 * ---
 * The release that needed repairing (`d7ebf9c`) shipped a router importing a
 * controller that had never been committed. Nothing noticed: the suites run
 * against isolated databases, and `/api/health` answering 200 proves the process
 * is alive and NOTHING about which revision it is, which routes exist, or
 * whether the private media roots are durable.
 *
 * The checks themselves live in `scripts/lib/contractProbe.mjs`, so the SAME
 * definition runs against a locally booted server in CI
 * (`scripts/release-boot-gate.mjs`) and against a deployed origin here.
 *
 * This script never authenticates, never uploads, never creates a record.
 *
 *   node scripts/production-probe.mjs                              # configured default
 *   node scripts/production-probe.mjs --api=https://… --web=https://… --product=<slug>
 *   PROD_API_BASE=… PROD_WEB_BASE=… PROD_PRODUCT_SLUG=… node scripts/production-probe.mjs
 *
 * Exit codes: 0 every probe matched · 1 at least one deviation · 2 the API could
 * not be reached at all (a finding, not a pass).
 */

import { runContractChecks } from './lib/contractProbe.mjs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const API = (argValue('api') || process.env.PROD_API_BASE || 'https://flora-alchemy.onrender.com').replace(/\/$/, '');
const WEB = (argValue('web') || process.env.PROD_WEB_BASE || 'https://flora-alchemyy.vercel.app').replace(/\/$/, '');
/**
 * A product slug decides whether the public 3D checks are STRONG or vacuous.
 *
 * Without one, `contractProbe` can only assert "an unknown slug is 404" — which a
 * deployment that never mounted the public route also satisfies, so the probe
 * reported `25 passed` while saying nothing about 3D delivery. With a slug it
 * asserts the 200 + `product3d` key and the `404 ASSET_NOT_FOUND` refusal.
 *
 * So when the operator does not name a product, use the first one the deployed
 * catalogue returns: it is a public read, and any real product is enough because
 * the checks are about the route contract, not about that product's model.
 */
async function firstCatalogueSlug() {
  try {
    const res = await fetch(`${API}/api/products`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return '';
    const json = await res.json();
    const rows = json?.data || json?.products || [];
    const hit = rows.find((row) => row && (row.slug || row.id));
    return hit ? String(hit.slug || hit.id) : '';
  } catch {
    return '';
  }
}

const PRODUCT_SLUG = argValue('product') || process.env.PROD_PRODUCT_SLUG || (await firstCatalogueSlug());

console.log('Flora Alchemy — production contract probe (read-only)');
console.log('─────────────────────────────────────────────────────');
console.log(`  api  : ${API}`);
console.log(`  web  : ${WEB}`);
if (PRODUCT_SLUG) {
  console.log(`  product : ${PRODUCT_SLUG}`);
} else {
  console.log('  product : (none — the public 3D checks can only be vacuous this way)');
}
console.log('');

const result = await runContractChecks({
  api: `${API}/api`,
  web: WEB,
  productSlug: PRODUCT_SLUG,
  note: (message) => console.log(`  ⚠ ${message}`),
});

console.log('\n─────────────────────────────────────────────────────');
console.log(`PRODUCTION PROBE: ${result.passed} passed, ${result.failed} failed`);
if (result.unreachable) {
  console.error('\n✘ the deployed API did not answer at all — that is a release finding, not a pass.');
  process.exit(2);
}
if (result.failed > 0) {
  console.log('Deviations:');
  for (const f of result.failures) console.log(`  - ${f}`);
  console.log('\nThe deployed revision does not match the documented contract.');
  process.exit(1);
}
console.log('Every documented contract held.');
process.exit(0);
