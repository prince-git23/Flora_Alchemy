<!--
Flora Alchemy PR template.
`main` is the deploy branch: Render and Vercel auto-deploy on push, so a merge is a release.
Remember: development and production currently share the same MongoDB database — see
docs/DATABASE.md and the "Data Isolation" section of DEPLOYMENT.md before touching data.
-->

## Summary

<!-- One or two sentences: what this PR does. -->

## What Changed

<!-- Bullet the concrete changes (files/modules). -->

-

## Why

<!-- The problem, defect, or requirement being addressed. If fixing a bug, note the
     consequence of the bug — that is usually the real justification. -->

## Files/Modules Affected

<!-- e.g. frontend/src/services/productService.js, backend/controllers/orderController.js -->

-

## Testing Performed

<!-- Exact commands run and what you observed. -->

- [ ] `npm run build` (frontend compile check)
- [ ] `npm test` (backend suites — expect 367 pass / 0 fail)
- Targeted suites run:
- Manual browser verification (which flows, storefront and/or `/admin`):
- Console / network checked:

## UI Screenshots

<!-- Required for visual changes. Include desktop (~1440px) + mobile (~390px), and both
     light and dark themes where the surface supports them. If you could not capture
     screenshots, state which surfaces you verified some other way. -->

| Surface | Light | Dark |
|---|---|---|
| Desktop | | |
| Mobile | | |

## Environment/Configuration Changes

<!-- New/renamed/removed variables, and whether the hosting dashboard needs updating.
     Never paste secret values. -->

- [ ] No environment changes
- Variables added/changed:
- Dashboard update required (Render/Vercel): yes / no

## Database Changes

<!-- New fields, indexes, or data migrations. Note that schema changes apply to the
     shared production/development database immediately. -->

- [ ] No database changes
- Schema/index changes:
- Migration or backfill required:
- Backup taken before any data mutation: yes / no / N/A

## Breaking Changes

<!-- Anything that changes an existing contract: API shape, env vars, routes, data format. -->

- [ ] None
- Details:

## Production Impact

<!-- Does this affect live data, auth, payments, orders, inventory, or the deployment
     configuration? Be explicit. -->

- [ ] None / no production effect
- Details:

## Checklist

- [ ] No secrets committed (`.env*` untouched; no credentials, tokens or keys in
      source, docs, comments, or the diff)
- [ ] Tests run (`npm test` — 367 pass / 0 fail, or the affected suites, and I explain
      any deviation)
- [ ] Build checked when relevant (`npm run build` for any frontend change)
- [ ] Database impact reviewed (shared dev/prod database considered; deletes scoped and
      backed up; no legitimate business data removed)
- [ ] Production impact reviewed (auth / payments / orders / inventory / deployment
      config left safe; no DEV-only UI shipped without an `import.meta.env.DEV` gate)
- [ ] UI screenshots added when applicable (light + dark, desktop + mobile)
- [ ] Existing architecture reused where possible (no duplicated services/components,
      no unnecessary dependencies, no second HTTP client)
