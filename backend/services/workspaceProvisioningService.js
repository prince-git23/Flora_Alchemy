import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import Settings from '../models/Settings.js';
import AdminApplication from '../models/AdminApplication.js';
import Invitation from '../models/Invitation.js';
import { staffIdFor } from '../utils/staffIdentity.js';
import { slugify, validateWorkspaceSlug } from '../utils/workspaceSlug.js';

/**
 * Phase 22.4 — ADMIN INVITATION ACTIVATION → WORKSPACE PROVISIONING.
 *
 * This is the ONLY place in the codebase where a Workspace document is
 * created (models/Workspace.js invariant). It runs inside ONE MongoDB
 * transaction so activation is all-or-nothing:
 *
 *   1. consume the invitation (single-use INVITED → ACTIVE gate — the same
 *      atomic transition as before, but now transactional, so a failure
 *      later in the flow AUTOMATICALLY returns the token to INVITED);
 *   2. resolve + validate the workspace slug (format, reserved routes) and
 *      prove uniqueness against Workspace — a collision aborts with
 *      409 WORKSPACE_SLUG_TAKEN and the invitation stays usable for a retry
 *      with an alternative address (never a silent rename);
 *   3. create the Workspace (status ACTIVE, isFixture false);
 *   4. create the administrator User — every field SERVER-controlled:
 *      role 'admin', isOwner false, workspaceId = the new workspace, ADM-
 *      staffId pre-allocated. Client-supplied workspaceId/role/isOwner/
 *      status/staffId never reach this function (workspaceId is scrubbed in
 *      server.js; the controller never forwards the others);
 *   5. stamp Workspace.primaryAdminId;
 *   6. seed the workspace Settings document — cloned from the pre-migration
 *      singleton (store defaults) with identity fields overridden. Secrets
 *      were never part of Settings (JWT/CORS/rate-limit/env config lives in
 *      process.env), so a clone cannot leak platform configuration;
 *   7. linked application → ACTIVATED.
 *
 * On ANY failure the transaction aborts: no Workspace, no User, no
 * Settings, and the invitation is back to INVITED — a collision-retry or a
 * transient error never strands the applicant.
 */

/** Structured failure carrying the HTTP contract out of the transaction. */
export class ProvisioningError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProvisioningError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Resolve the workspace identity (slug + displayName) for an admin
 * activation from, in order of authority:
 *   1. an explicit suggestion from the recipient (collision retry — the
 *      only field that may override the approved slug; still validated);
 *   2. the APPROVED identity stamped on the invitation / application;
 *   3. deterministic derivation: slugify(approved name / recipient name),
 *      else the email local part — never a random string.
 *
 * @returns {{ok:true, slug:string, displayName:string}
 *          | {ok:false, status:number, code:string, message:string}}
 */
export function resolveWorkspaceIdentity({ inv, application, suggestedSlug, suggestedName }) {
  const approvedName = String(inv.workspaceName || application?.businessName || '').trim();
  const displayName = [
    approvedName,
    String(suggestedName || '').trim(),
    String(inv.recipientName || '').trim(),
    String(application?.name || '').trim(),
  ].find((s) => s.length >= 2) || '';

  const suggestion = String(suggestedSlug || '').trim();
  let slug = '';

  if (suggestion) {
    // An explicit alternative must be valid — refuse it actionably instead
    // of silently falling back to the approved address.
    const check = validateWorkspaceSlug(suggestion);
    if (!check.ok) return { ok: false, status: 422, code: check.code, message: check.message };
    slug = check.slug;
  } else {
    const approved = String(inv.workspaceSlug || application?.proposedSlug || '').trim();
    if (approved) {
      const check = validateWorkspaceSlug(approved);
      if (check.ok) slug = check.slug;
    }
    if (!slug) {
      for (const candidate of [
        slugify(displayName),
        slugify(String(inv.recipientEmail || '').split('@')[0]),
      ]) {
        const check = validateWorkspaceSlug(candidate);
        if (check.ok) {
          slug = check.slug;
          break;
        }
      }
    }
    if (!slug) {
      return {
        ok: false,
        status: 422,
        code: 'INVALID_SLUG',
        message:
          'Could not determine a workspace address for this invitation. Provide one (lowercase letters, numbers and hyphens) and try again.',
      };
    }
  }

  let finalName = displayName || slug; // derived, never random
  if (finalName.length > 120) finalName = finalName.slice(0, 120);
  return { ok: true, slug, displayName: finalName };
}

/**
 * Settings seed for a NEW workspace: clone the pre-migration singleton's
 * store configuration (if one exists) and override the identity fields.
 * Runs OUTSIDE the transaction (plain read) to keep the write set small.
 */
async function settingsSeed() {
  const seed = {};
  try {
    const singleton = await Settings.findOne({ key: 'default' }).lean();
    if (singleton) {
      Object.assign(seed, singleton);
      for (const field of ['_id', '__v', 'key', 'workspaceId', 'createdAt', 'updatedAt', 'isFixture']) {
        delete seed[field];
      }
    }
  } catch {
    /* no singleton yet — schema defaults fill the gaps on create */
  }
  return seed;
}

/**
 * Consume the invitation and provision Workspace + Admin + Settings in one
 * transaction. Pre-checks (password, token state, free email) happen in the
 * controller BEFORE this runs, exactly as before.
 *
 * @param {object}   opts
 * @param {object}   opts.inv         the loaded invitation (pre-activation)
 * @param {object|null} opts.application  linked admin application, if any
 * @param {string}   opts.email       recipient email (lowercase)
 * @param {string}   opts.passwordHash bcrypt-12 hash of the chosen password
 * @param {string}   opts.name        account display name (application-derived)
 * @param {string}   [opts.suggestedSlug] recipient's alternative slug
 * @param {string}   [opts.suggestedName] recipient's name suggestion (rare)
 * @returns {Promise<{user:object, workspace:{id:string, slug:string, displayName:string}>}}
 * @throws {ProvisioningError} with the HTTP status/code/message to answer
 */
export async function activateAdminInvitation({
  inv,
  application,
  email,
  passwordHash,
  name,
  suggestedSlug = '',
  suggestedName = '',
}) {
  if (application && application.status === 'REJECTED') {
    throw new ProvisioningError(
      409,
      'APPLICATION_NO_LONGER_VALID',
      'This application is no longer valid. Contact the owner for guidance.'
    );
  }

  const identity = resolveWorkspaceIdentity({ inv, application, suggestedSlug, suggestedName });
  if (!identity.ok) {
    throw new ProvisioningError(identity.status, identity.code, identity.message);
  }
  const { slug, displayName } = identity;

  const seed = await settingsSeed();

  const attempt = async () => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      // 1 — single-use gate. Inside the transaction, so every later failure
      // returns the token to INVITED automatically on abort.
      const now = new Date();
      const consumed = await Invitation.findOneAndUpdate(
        { _id: inv._id, status: 'INVITED', expiresAt: { $gt: now } },
        { $set: { status: 'ACTIVE', consumedAt: now } },
        { new: true, session }
      );
      if (!consumed) {
        const current = await Invitation.findById(inv._id)
          .select('status expiresAt')
          .session(session)
          .lean();
        if (!current) {
          throw new ProvisioningError(404, 'INVITATION_NOT_FOUND', 'This invitation link is not valid.');
        }
        if (current.status === 'EXPIRED' || current.expiresAt <= new Date()) {
          throw new ProvisioningError(
            410,
            'INVITATION_EXPIRED',
            'This invitation has expired. Ask the owner to issue a new one.'
          );
        }
        throw new ProvisioningError(
          409,
          'INVITATION_ALREADY_ACTIVATED',
          'This invitation has already been activated. Sign in instead.'
        );
      }

      // 2 — authoritative slug uniqueness (unique index is the backstop;
      // this gives the collision a clean, actionable answer).
      const taken = await Workspace.findOne({ slug }).session(session).select('_id');
      if (taken) {
        throw new ProvisioningError(
          409,
          'WORKSPACE_SLUG_TAKEN',
          'That workspace address is already in use. Choose a different one and submit again — this invitation is still valid.'
        );
      }

      // 3 — the workspace itself (the ONLY Workspace.create in the repo).
      const [workspace] = await Workspace.create(
        [{ slug, displayName, status: 'ACTIVE', isFixture: false }],
        { session }
      );

      // 4 — the administrator. Client-supplied identity fields are not
      // parameters here at all: role/owner/workspace/badge are server-set.
      const newId = new mongoose.Types.ObjectId();
      const [user] = await User.create(
        [
          {
            _id: newId,
            email,
            passwordHash,
            role: 'admin',
            name,
            status: 'ACTIVE',
            isFixture: false,
            isOwner: false, // ownership is granted explicitly, never by invitation
            staffId: staffIdFor(newId, 'admin'),
            department: inv.department || '',
            phone: inv.phone || '',
            staffNotes: inv.notes || '',
            invitedBy: inv.inviter || null,
            workspaceId: workspace._id,
          },
        ],
        { session }
      );

      // 5 — ownership anchor on the workspace.
      await Workspace.updateOne(
        { _id: workspace._id },
        { $set: { primaryAdminId: user._id } },
        { session }
      );

      // 6 — per-workspace settings (store defaults cloned from the
      // singleton; identity fields point at the new workspace).
      await Settings.create(
        [
          {
            ...seed,
            key: slug,
            workspaceId: workspace._id,
            storeName: displayName,
            isFixture: false,
          },
        ],
        { session }
      );

      // 7 — the dossier records the outcome (non-critical bookkeeping kept
      // inside the transaction so it cannot be forgotten after a commit).
      if (application) {
        await AdminApplication.updateOne(
          { _id: application._id },
          { $set: { status: 'ACTIVATED' } },
          { session }
        );
      }

      await session.commitTransaction();
      return {
        user,
        workspace: {
          id: workspace._id.toString(),
          slug: workspace.slug,
          displayName: workspace.displayName,
        },
      };
    } catch (err) {
      await session.abortTransaction().catch(() => {});
      throw err;
    } finally {
      session.endSession();
    }
  };

  try {
    return await attempt();
  } catch (err) {
    // One retry for a transient transaction conflict (same policy as the
    // approve flow in adminApplicationController).
    const labels =
      (err && err.errorLabels) ||
      (err && err.errorResponse && err.errorResponse.errorLabels) ||
      [];
    if (err instanceof ProvisioningError) throw err;
    if (err && (err.code === 112 || err.code === 11000 || labels.includes('TransientTransactionError'))) {
      try {
        return await attempt();
      } catch (retryErr) {
        throw mapDuplicate(retryErr);
      }
    }
    throw mapDuplicate(err);
  }
}

/** Translate duplicate-key aborts into the public HTTP contract. */
function mapDuplicate(err) {
  if (err instanceof ProvisioningError) return err;
  if (err && err.code === 11000) {
    const key = err.keyPattern ? Object.keys(err.keyPattern)[0] : '';
    const text = `${key} ${err.message || ''}`;
    if (/slug/i.test(text)) {
      return new ProvisioningError(
        409,
        'WORKSPACE_SLUG_TAKEN',
        'That workspace address is already in use. Choose a different one and submit again — this invitation is still valid.'
      );
    }
    return new ProvisioningError(
      409,
      'EMAIL_TAKEN',
      'An account with this email already exists. Sign in instead.'
    );
  }
  throw err;
}
