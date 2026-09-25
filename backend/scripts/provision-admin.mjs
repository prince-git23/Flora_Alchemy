/**
 * Phase 20.6.1 — FIRST-OWNER PROVISIONING (`npm run provision-admin`).
 *
 * Creates the FIRST legitimate owner/admin account in whatever database
 * MONGO_URI points at. This is deliberately a server-side command — not a
 * public endpoint, not a frontend flow — so privileged account creation can
 * never be triggered by an unauthenticated HTTP request.
 *
 * Safety model (fail closed at every step):
 *   1. Target database is classified with utils/environmentGuard.js.
 *      - disposable (test/qa/dev/smoke/sandbox name or localhost) → allowed.
 *      - anything else (production, unknown) → requires BOTH
 *          CONFIRM_DATABASE_UNSAFE_OPERATION=<exact db name>   (Phase 20.6 guard)
 *          PROVISION_ADMIN_CONFIRM=CREATE_PRODUCTION_ADMIN     (explicit intent)
 *        This is a narrow, additive scope: it does NOT weaken assertSafeDatabase,
 *        which still refuses ordinary writes to protected databases.
 *   2. Refuses when an ACTIVE administrator already exists — unless the
 *      authorized recovery procedure is acknowledged with
 *      PROVISION_ADMIN_RECOVERY=I_UNDERSTAND_AN_ADMIN_EXISTS.
 *   3. Refuses duplicate emails (checked against the live database).
 *   4. Password comes from PROVISION_ADMIN_PASSWORD or a hidden interactive
 *      prompt (typed twice). Minimum 12 characters for bootstrap.
 *      It is NEVER hardcoded, NEVER printed, NEVER logged, NEVER returned.
 *   5. The account is role=admin, status=ACTIVE, isFixture=false — a real
 *      owner account, not a fixture.
 *
 * Usage (development / disposable database):
 *   PROVISION_ADMIN_EMAIL=owner@example.com npm run provision-admin
 *   (prompts for the password with hidden input)
 *
 * Usage (production — deliberate, two-step confirmation):
 *   CONFIRM_DATABASE_UNSAFE_OPERATION=Flora-Alchemy \
 *   PROVISION_ADMIN_CONFIRM=CREATE_PRODUCTION_ADMIN \
 *   PROVISION_ADMIN_EMAIL=<owner email> npm run provision-admin
 *
 * The first-owner bootstrap is allowed only while NO active admin exists.
 * After that, use the existing admin API (POST /api/admin/users) instead.
 */
import 'dotenv/config';
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { classifyDatabase, describeDatabase } from '../utils/environmentGuard.js';
import User from '../models/User.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 12;

function refuse(message, detail = '') {
  console.error(`[provision] REFUSED: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

/** Hidden-input prompt (echo suppressed). Only used on an interactive TTY. */
function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const originalWrite = rl.output.write.bind(rl.output);
    rl.output.write = (chunk, ...args) => (muted ? true : originalWrite(chunk, ...args));
    originalWrite(query);
    muted = true;
    rl.question('', (answer) => {
      muted = false;
      originalWrite('\n');
      rl.close();
      resolve(answer);
    });
  });
}

// ── 1. Target database classification ─────────────────────────────────────
const uri = process.env.MONGO_URI;
if (!uri) refuse('MONGO_URI is not configured. Refusing to guess a target database.');

const info = classifyDatabase(uri);
if (!info.dbName) refuse('could not determine the database name from MONGO_URI.');

if (!info.disposable) {
  // Production (or any non-disposable database): two independent confirmations.
  const confirmDb = process.env.CONFIRM_DATABASE_UNSAFE_OPERATION || '';
  if (confirmDb !== info.dbName) {
    refuse(
      `target database "${info.dbName}" is not disposable.`,
      [
        '  This command writes a privileged account. To authorize a one-off run against',
        `  this database, re-run with CONFIRM_DATABASE_UNSAFE_OPERATION=${info.dbName}`,
        '  (exact database name — an accidental copy-paste will not match).',
        '  Ordinary database writes remain refused by the environment guard either way.',
      ].join('\n')
    );
  }
  if (process.env.PROVISION_ADMIN_CONFIRM !== 'CREATE_PRODUCTION_ADMIN') {
    refuse(
      'missing explicit provisioning confirmation.',
      '  Re-run with PROVISION_ADMIN_CONFIRM=CREATE_PRODUCTION_ADMIN to acknowledge that',
      '  this creates a privileged owner account in a non-disposable database.'
    );
  }
  console.warn(`[provision] AUTHORIZED privileged write — ${describeDatabase(uri)}`);
} else {
  console.log(`[provision] target — ${describeDatabase(uri)}`);
}

// ── 2. Inputs ─────────────────────────────────────────────────────────────
const email = String(process.env.PROVISION_ADMIN_EMAIL || '').trim().toLowerCase();
if (!email || !EMAIL_RE.test(email)) {
  refuse('a valid owner email is required.', '  Set PROVISION_ADMIN_EMAIL=<owner@example.com> and re-run.');
}
const name =
  String(process.env.PROVISION_ADMIN_NAME || '').trim() ||
  email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

let password = String(process.env.PROVISION_ADMIN_PASSWORD || '');
if (!password) {
  if (process.stdin.isTTY) {
    console.log(`Provisioning owner account for ${email} (password input is hidden).`);
    const first = await promptHidden('  Password (min 12 chars): ');
    const second = await promptHidden('  Repeat password:        ');
    if (first !== second) refuse('passwords do not match.');
    password = first;
  } else {
    refuse(
      'no password supplied and no interactive terminal available.',
      [
        '  Set PROVISION_ADMIN_PASSWORD (minimum 12 characters) in the environment, e.g.:',
        '    PROVISION_ADMIN_PASSWORD=... npm run provision-admin',
        '  Never commit it, never put it in a file that is tracked by git, and never',
        '  share it in chat/logs. This command never prints or stores it in plaintext.',
      ].join('\n')
    );
  }
}
if (password.length < MIN_PASSWORD) {
  refuse(`owner password must be at least ${MIN_PASSWORD} characters (bootstrap requires a strong password).`);
}

// ── 3. Connect and check live database state ──────────────────────────────
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
} catch (err) {
  refuse(`could not connect to the target database: ${err.message}`);
}

try {
  const users = mongoose.connection.db.collection('users');

  const duplicate = await users.findOne({ email }, { projection: { email: 1 } });
  if (duplicate) {
    refuse(`a user with this email already exists (${email}). No duplicate account was created.`);
  }

  // Active owner/admin check against the ACTUAL database — not NODE_ENV,
  // not local files. Suspended admins do not count as active.
  const activeAdmin = await users.findOne(
    { role: 'admin', status: { $ne: 'SUSPENDED' } },
    { projection: { email: 1 } }
  );
  if (activeAdmin) {
    if (process.env.PROVISION_ADMIN_RECOVERY !== 'I_UNDERSTAND_AN_ADMIN_EXISTS') {
      refuse(
        `an active administrator already exists (${activeAdmin.email}).`,
        [
          '  First-owner bootstrap runs only while no active admin exists — this protects',
          '  the system from accidental extra owners. To add another admin:',
          '    · recommended: have the existing admin create one via POST /api/admin/users',
          '    · authorized recovery (lost access / second owner): re-run with',
          '        PROVISION_ADMIN_RECOVERY=I_UNDERSTAND_AN_ADMIN_EXISTS',
        ].join('\n')
      );
    }
    console.warn(`[provision] RECOVERY MODE — an active admin already exists (${activeAdmin.email}); creating an additional admin as explicitly authorized.`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({
    email,
    passwordHash,
    role: 'admin',
    name,
    isFixture: false,
  });

  console.log(
    `[provision] CREATED owner/admin — email=${user.email} role=${user.role} status=${user.status} isFixture=${user.isFixture} db=${info.dbName}`
  );
  console.log('[provision] Password was hashed with bcrypt-12 and never printed. Share it with the owner out-of-band.');
  console.log('[provision] Next step: sign in at /admin/login with POST /api/auth/login (single auth endpoint).');
} catch (err) {
  if (err && err.code === 11000) {
    refuse(`a user with this email already exists (${email}). No duplicate account was created.`);
  }
  refuse(`provisioning failed: ${err.message}`);
} finally {
  await mongoose.disconnect().catch(() => {});
}
