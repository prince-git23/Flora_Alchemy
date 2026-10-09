/**
 * PHASE 4 — the fixture identities, in ONE place.
 *
 * WHY
 * ---
 * The demo customer password and the demo handler password used to be literals
 * inside `seed.js`. The browser E2E suite has to sign in as those same seeded
 * users, and copying the literals into the suite would have created a second
 * place where a fixture credential lives in source — the exact thing the
 * production-safety rules forbid. So the literals live here, `seed.js` reads
 * them from here, and the suite reads them from here. One definition, one place
 * to audit.
 *
 * These are DEMO credentials for disposable databases only:
 *   · `seed.js` refuses to create them unless the target database is
 *     disposable (`assertFixtureAccountsAllowed`) and never runs in production
 *     (`SEED_ON_START=true` is rejected there);
 *   · the E2E stack refuses a database name without a disposable marker before
 *     it spawns anything.
 *
 * Never provision these accounts in a real database, and never print the values
 * into a log, a report, or a production bundle.
 */

export const DEMO_CUSTOMER = {
  name: 'Demo Customer',
  email: 'customer@example.com',
  phone: '+91 98000 00000',
  password: 'demo1234',
};

export const DEMO_HANDLER = {
  name: 'Handler Admin',
  email: 'handler.admin@flora-alchemy.demo',
  password: 'handler1234',
};

/** The fixture customers seeded beyond the demo account (no sign-in needs). */
export const FIXTURE_CUSTOMERS = [
  { name: 'Aarav Mehta', email: 'aarav.mehta@example.com', phone: '+91 98200 12345', city: 'Mumbai', state: 'Maharashtra' },
  { name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+91 98111 23456', city: 'New Delhi', state: 'Delhi' },
  { name: 'Ananya Verma', email: 'ananya.verma@example.com', phone: '+91 98333 45678', city: 'Bangalore', state: 'Karnataka' },
  { name: 'Sneha Nair', email: 'sneha.nair@example.com', phone: '+91 98999 01234', city: 'Kochi', state: 'Kerala' },
];
