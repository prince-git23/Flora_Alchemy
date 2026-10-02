/**
 * AUTH ROUTE PLAN SMOKE — the Owner contract at the route-plan layer.
 *
 * Regression guard for the reported Owner bug: a perfectly valid Owner login
 * (role=admin, isOwner=true, workspaceId=null, status=ACTIVE) must NOT be
 * planned as a workspace administrator. The workspace console slices
 * (orders / customers / inventory / analytics and the admin-scoped identity)
 * are refused by the backend with 403 WORKSPACE_REQUIRED for the workspace-less
 * Owner by design, so demanding them as CRITICAL flipped the WHOLE Owner Portal
 * into an access-refusal screen immediately after a valid login.
 *
 * The plan is a pure function with no imports, so it is verified directly:
 *   node scripts/auth-route-plan-smoke.mjs
 */
import { dataRequirementsFor } from '../src/services/routeDataRequirements.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2714 ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  \u2718 ${name}\n      ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// The ADMIN-TOKEN console slices the backend refuses for a workspace-less
// identity (403 WORKSPACE_REQUIRED). None may ever be CRITICAL for the Owner.
// `identity` is deliberately NOT in this list: it is the /auth/me slice, which
// is legitimate for a CUSTOMER session — it is workspace-refused only when it
// is the ADMIN-scoped read, which is asserted separately for the Owner.
const WORKSPACE_SLICES = ['orders', 'customers', 'inventory', 'analytics'];

const owner = { hasAdminSession: true, isOwner: true, permissions: null };
const admin = { hasAdminSession: true, isOwner: false, permissions: null };
const handler = { hasAdminSession: true, isOwner: false, permissions: ['orders.view'] };

function noWorkspaceSlices(plan, label) {
  const leaked = WORKSPACE_SLICES.filter((s) => plan.critical.includes(s));
  assert(
    leaked.length === 0,
    `${label}: workspace-scoped slice(s) [${leaked.join(', ')}] are CRITICAL — the backend answers 403 WORKSPACE_REQUIRED for a workspace-less Owner`
  );
}

console.log('\n\u2014 OWNER (role=admin, isOwner=true, workspaceId=null) \u2014');

check('Owner Portal (/owner/dashboard) never demands a workspace slice', () => {
  const plan = dataRequirementsFor('/owner/dashboard', owner);
  noWorkspaceSlices(plan, '/owner/dashboard');
  assert(
    !plan.critical.includes('identity'),
    '/owner/dashboard: the ADMIN-scoped identity read is refused with WORKSPACE_REQUIRED for the Owner'
  );
  assert(plan.critical.includes('settings'), '/owner/dashboard: settings (public) should still be critical');
});

check('Owner is planned by identity, not as a workspace administrator', () => {
  const plan = dataRequirementsFor('/owner/dashboard', owner);
  assert(plan.route === 'owner portal', `expected route 'owner portal', got '${plan.route}'`);
});

check('governance pages the Owner reaches under /admin are planned the same way', () => {
  for (const path of ['/admin/dashboard', '/admin/settings', '/admin/staff']) {
    const plan = dataRequirementsFor(path, owner);
    noWorkspaceSlices(plan, path);
    assert(!plan.critical.includes('identity'), `${path}: admin-scoped identity is workspace-refused for the Owner`);
    assert(plan.route === 'owner portal', `${path}: expected route 'owner portal', got '${plan.route}'`);
  }
});

check('a non-owner administrator is UNCHANGED: full console, no owner shortcut', () => {
  const plan = dataRequirementsFor('/admin/dashboard', admin);
  assert(plan.route === 'portal', `expected route 'portal', got '${plan.route}'`);
  assert(
    ['orders', 'customers', 'inventory', 'analytics'].every((s) => plan.critical.includes(s)),
    'a workspace administrator must still hydrate the workspace console slices'
  );
});

check('a granular handler only hydrates the slices its role may read', () => {
  const plan = dataRequirementsFor('/staff/dashboard', handler);
  assert(plan.critical.includes('settings'), 'settings is public and always readable');
  assert(!plan.critical.includes('customers'), 'customers.view is absent — the slice must not be requested');
  assert(!plan.critical.includes('analytics'), 'analytics.view is absent — the slice must not be requested');
});

console.log('\n\u2014 PORTAL ENTRY POINTS \u2014');

check('portal logins are auth-class: no store data gates the form', () => {
  for (const path of ['/owner/login', '/admin/login', '/staff/login', '/access', '/portal']) {
    const plan = dataRequirementsFor(path, owner);
    assert(plan.route === 'auth', `${path}: expected route 'auth', got '${plan.route}'`);
    assert(plan.critical.length === 0, `${path}: an auth screen must never gate on store data`);
  }
});

check('an anonymous portal visit gets the public storefront, never a console slice', () => {
  const plan = dataRequirementsFor('/owner/dashboard', { hasAdminSession: false, isOwner: false });
  noWorkspaceSlices(plan, 'anonymous /owner/dashboard');
  assert(plan.critical.includes('products') && plan.critical.includes('settings'), 'public slices expected');
});

console.log('\n\u2014 STOREFRONT IS UNCHANGED \u2014');

check('a customer route hydrates the public catalogue plus their identity', () => {
  const plan = dataRequirementsFor('/shop', { hasCustomerSession: true });
  assert(plan.critical.includes('products') && plan.critical.includes('settings'), 'public slices expected');
  assert(plan.critical.includes('identity'), 'the signed-in identity backs the navbar label');
  noWorkspaceSlices(plan, 'customer /shop');
});

check('a workspace storefront resolves its own tenant catalogue', () => {
  const plan = dataRequirementsFor('/shops/some-atelier', {});
  assert(plan.critical.length === 0 && plan.background.length === 0, 'the page owns its own scoped fetch');
});

console.log(`\nAUTH ROUTE PLAN RESULT: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`  failed: ${failures.join(' | ')}`);
  process.exit(1);
}
