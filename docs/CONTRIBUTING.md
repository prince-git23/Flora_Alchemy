# Contributing to Flora Alchemy

> Practical contribution guide. Related: [AGENTS.md](../AGENTS.md) (agent rules),
> [ARCHITECTURE.md](./ARCHITECTURE.md), [DESIGN.md](./DESIGN.md),
> [TESTING.md](./TESTING.md), [DATABASE.md](./DATABASE.md),
> [DEPLOYMENT.md](../DEPLOYMENT.md).

---

## 🚨 Read this before touching data

**Development and production currently share the same MongoDB database.** Local
seed/QA/cleanup operations write straight into what customers see. See the
[Data Isolation](../DEPLOYMENT.md) section and
[DATABASE.md](./DATABASE.md#release-blocker-shared-productiondevelopment-database).

If your change touches data, follow the [Safe database workflow](#safe-database-workflow)
below. When in doubt, do not delete anything.

## Development workflow

1. **Inspect first.** Find the existing pattern for what you are changing —
   service, component, route, controller or model. This codebase is consistent;
   matching the nearest existing file is almost always right.
2. **Run the stack locally.**
   ```bash
   npm run install:all              # once
   npm run api:dev                  # backend  → http://localhost:4000
   npm run dev                      # frontend → http://localhost:3000
   ```
   `VITE_API_URL` must include the **`/api`** suffix
   (e.g. `http://localhost:4000/api`). The backend needs `backend/.env` with
   `MONGO_URI` and `JWT_SECRET` (copy `backend/.env.example`).
   Windows helpers exist under `.freebuff/` (`start-mongod.ps1`,
   `start-backend.ps1`, `start-server.ps1`).
3. **Make the smallest change that solves the problem.** Reuse before you create
   (see below).
4. **Verify** (see [Testing before commit](#testing-before-commit)).
5. **Commit** and open a PR (see [PR requirements](#pr-requirements)).

## Branch expectations

- `main` is the only long-lived branch, and it is the deploy branch — Render and
  Vercel **auto-deploy on push to `main`**.
- Work on a short-lived branch named for the change
  (`fix/inventory-double-deduct`, `feat/gift-wrap-note`) and open a PR.
- **Never force-push `main`.** It is deployed.
- Do not commit directly to `main` unless you are the maintainer doing an
  intentional release commit.
- Keep the working tree clean before switching branches; do not stash or commit
  someone else's changes (`git add -A` is discouraged — stage specific paths).

## Naming conventions

| Kind | Convention | Example |
|---|---|---|
| React component / page | `PascalCase.jsx`, default export | `ProductCard.jsx`, `AdminOrderDetailPage.jsx` |
| Frontend service / util | `camelCase.js` | `productService.js`, `apiClient.js` |
| Context provider | `PascalCaseContext.jsx` exporting `useX` | `ThemeContext.jsx` → `useTheme` |
| Backend route / controller | `xRoutes.js` / `xController.js` | `orderRoutes.js`, `orderController.js` |
| Backend model | `PascalCase.js` (Mongoose) | `InventoryMovement.js` |
| Backend service / util | `xService.js` / `camelCase.js` | `inventoryService.js`, `querySafety.js` |
| Test suite | `x-smoke.mjs` / `x-test.mjs` | `api-smoke.mjs` |

Other conventions:

- **Public ids are slugs** for products and collections; orders use `orderId`
  (`FA-####`); inventory is keyed by `productSlug`.
- **API envelopes** — success `{ success: true, ... }`; error
  `{ success: false, message, code }`. Throw `ApiError(status, message, code)`
  from controllers and let `errorMiddleware` shape it; never hand-roll an error body.
- **Frontend HTTP** — only through `services/apiClient.js`. Never call `fetch` from a
  page or component.
- **Colours/spacing** — use the `--color-*` design tokens in
  `frontend/src/index.css`; do not hardcode new colours (see [DESIGN.md](./DESIGN.md)).

### Reuse before you create

Before adding anything, check whether it exists:

- a **service** per domain already exists (`productService`, `orderService`,
  `inventoryService`, `conversationService`, `wishlistService`, `customerService`,
  `collectionService`, `paymentService`, `notificationService`, `analyticsService`,
  `adminUserService`, `adminSettings`, `giftFinderService`, `settingsService`,
  `customRequestService`, `authService`);
- shared UI components exist (`ProductCard`, `StatusPill`, `Skeleton*`,
  `OrderStatusTracker`, `ImageUploader`, `AdminLayout`, …);
- shared backend helpers exist (`adjustStock`, `reserveStockForOrder`,
  `assertValidTransition`, `cached`/`cacheInvalidatePrefix`, `escapeRegExp`/`safeString`,
  `createNotification`/`createNotificationsForUsers`).

**Do not** duplicate an existing service or component, add a second HTTP client,
re-implement stock arithmetic, or add a dependency the stack already covers. New
runtime dependencies need a clear justification and should be rare.

## Testing before commit

Run at least:

```bash
npm run build      # frontend compile check — required for any frontend change
npm test           # backend suites — expect 691 pass / 0 fail
```

- Run the **full** `npm test` before committing, even if you iterated on one suite.
- Backend suites are isolated (own server, own `Flora-Alchemy-Test-*` database), so
  `npm test` is safe to run even though production shares the dev database.
- **Never weaken or delete an assertion to make a suite pass.** These assertions
  encode security and business invariants (server-authoritative pricing, ownership
  404s, exactly-one-deduction). If a suite fails, decide whether the code or the
  expectation is wrong — and if the expectation itself was wrong, say so in the PR.
- New endpoints/behaviours should get an assertion in the closest existing suite;
  register new suites in `scripts/run-all.mjs`.
- See [TESTING.md](./TESTING.md) for per-suite detail.

## PR requirements

Use the template at [`.github/pull_request_template.md`](../.github/pull_request_template.md).
Every PR must include:

- **Summary + what changed + why** — the "why" is not optional.
- **Files/modules affected.**
- **Testing performed** — the exact commands and what you observed.
- **UI screenshots** when the change is visual (see below).
- **Environment/configuration changes** — new/renamed variables, and whether the
  hosting dashboard needs an update.
- **Database changes** — new fields/indexes, and whether any data must be migrated.
- **Breaking changes** and **production impact** — call out anything that affects
  live data, auth, payments, orders or inventory.
- The **checklist** completed (secrets, tests, build, database impact, production
  impact, screenshots, reuse).

## UI-change screenshot expectations

Include **before/after screenshots** for any visual change, for both themes when the
surface supports dark mode:

- desktop (~1440 px) and mobile (~390 px);
- **light and dark** (the design system is token-driven, so a change can look right
  in one theme and break the other);
- admin screens too — the portal is a first-class surface.

**Environment limitation:** screenshots could not be captured in the cloud
development environment used for the most recent audit (webview compositing), so
that audit verified styles programmatically. When you *can* attach screenshots,
always do; when you cannot, state explicitly in the PR which surfaces you verified
some other way and which you could not verify visually.

## Environment/configuration rules

- **Never commit secrets.** `.env*` is git-ignored (only `.env.example` is tracked).
  Never print secret values into source, logs, docs, PR descriptions, or commit
  messages.
- The backend variable is **`MONGO_URI`** (not `MONGODB_URI`).
- Adding a variable means updating **all three**: `backend/.env.example` (or
  `frontend/.env.example`), the README/`DEPLOYMENT.md` env table, and the hosting
  dashboard (out-of-band, and say so in the PR).
- **Anything frontend-facing must be DEV-gated if it is developer-only.** Use
  `import.meta.env.DEV`. Anything not gated ships to customers inside the bundle —
  this is exactly how demo credentials once leaked into production
  (see [MEMORY.md](./MEMORY.md#security-knowledge)).

## Safe database workflow

Because production and development share one database:

1. **Confirm the target.** Compare the database name in `backend/.env` `MONGO_URI`
   with the hosting dashboard value. If they match (they currently do), treat
   **every** local data operation as a production operation.
2. **Prefer reads.** Inspect before you mutate. Write throwaway scripts that
   `console.log` first, and only then consider a write.
3. **Back up before deleting.** Dump the exact documents you plan to remove
   (ids + full content) to a file outside the repository before running a delete.
4. **Scope deletes precisely.** Delete by explicit `_id`/`slug`/`orderId` lists —
   never by a broad filter you have not printed and reviewed.
5. **Prefer additive and reversible changes.** Ask the owner before anything that
   cannot be undone.
6. **Never run a destructive QA/cleanup script** (`deleteMany`, fixture resets,
   drops, bulk upserts) without explicit owner approval *and* a verified backup.
7. **Do not delete legitimate business data** — real orders, customers,
   conversations, or fixture documents flagged `isFixture`. When unsure whether a
   record is QA residue or real data, leave it and report it.
8. **Clean up your own artifacts**: temporary products/orders/uploads created for
   testing, and any scratch scripts (never leave `*.mjs` helpers behind).

## Production safety requirements

- `main` deploys automatically — **a push is a release**. Confirm intent before
  pushing.
- Never force-push, rebase published history, or rewrite `main`.
- Production boot requires `NODE_ENV=production`, `MONGO_URI`, `JWT_SECRET` and
  `CORS_ORIGIN`; the server refuses to start without them and refuses
  `SEED_ON_START=true`.
- Treat `auth`, `payments`, `orders`, `inventory` and `customer data` as sensitive:
  the server is authoritative for prices, totals and stock, ownership is derived
  from the token, and non-owners get `404`.
- Do not weaken rate limiting, CORS, Helmet, the session-expiry flow, or the
  DEV-gating of developer helpers.
- Verify the deployed result, not just the local build (health/readiness endpoints,
  and the affected flow on the live URL).

## Commit conventions

Observed convention across the history (48 commits carry the tooling footer):

```
Phase 20.4: stop shipping demo credentials in production bundles

The admin sign-in page offered a "Quick Fill Demo Credentials" button and
printed the seeded handler credentials as plain text ... (body explains WHY)

🤖 Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>
```

- **Subject:** `Phase <major>.<minor>: <short imperative summary>` — capitalised,
  no trailing period, ≤ ~72 chars. Phase numbers track the project's audit/release
  increments; use the current phase for ongoing work.
- **Body:** explain **why**, not just what. Wrap at ~72 chars. Mention the defect
  and its consequence when fixing something.
- **Footer:** the generated-with footer used by this repository's tooling.
- One logical change per commit. Do not commit generated output (`dist/`),
  dependencies, or `.env` files.
