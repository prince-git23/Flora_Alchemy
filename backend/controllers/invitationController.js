import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Invitation from '../models/Invitation.js';
import AdminApplication from '../models/AdminApplication.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { createNotification } from './notificationController.js';
import {
  roleLabel as accessRoleLabel,
  normalizePermissions,
  roleTemplate,
} from '../utils/permissions.js';
import { staffIdFor, roleLabel } from '../utils/staffIdentity.js';
import { recordStaffEvent } from '../utils/staffEvents.js';
import { getWorkspaceId } from '../utils/tenancy.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import {
  activateAdminInvitation,
  ProvisioningError,
} from '../services/workspaceProvisioningService.js';

/**
 * Phase 20.6.2 — invitation landing + one-time activation.
 *
 * The RAW token exists only in the single response that creates the
 * invitation (Phase 20.6.1 approve). Here we only ever compare SHA-256
 * hashes, so a database dump cannot replay an invitation.
 *
 * Security properties enforced by this controller:
 *   · public endpoints — no session required, but keyed by a 256-bit token
 *     (format-validated before it reaches a query, so junk input can never
 *     become a database probe)
 *   · single-use: consumption is an ATOMIC status transition
 *     (INVITED → ACTIVE guarded by status AND expiry in one update), so two
 *     concurrent activations can never both succeed
 *   · expiry is checked on every read; past-due invitations are lazily
 *     marked EXPIRED
 *   · the password is never echoed back, never logged, hashed with bcrypt-12
 *   · activation NEVER accepts a role — the role comes from the invitation,
 *     which was minted by the owner-approval step
 *
 * Response contract for GET mirrors what the landing page needs and nothing
 * more: no tokenHash, no inviter internals, no raw token.
 */

// randomBytes(32).toString('hex') → exactly 64 hex characters.
const TOKEN_RE = /^[a-f0-9]{64}$/i;
const MIN_PASSWORD = 6; // repo policy (public register / createOperator)

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function isValidObjectId(id) {
  return mongoose.isValidObjectId(id);
}

/** Presentation name for the account: application name if linked, else a
 *  readable form of the email local part (never invents a person). */
function deriveName(email, application) {
  if (application && application.name) return application.name;
  const local = String(email).split('@')[0] || '';
  return local
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Staff Member';
}

/**
 * The name the activated HANDLER account gets.
 *
 * Order of authority: what the person typed on the activation screen → the
 * name their inviter captured with the invitation → a readable form of the
 * email. A handler invitation may therefore carry NO name at all (the invite
 * form allows it) and the invitee completes it; if neither exists the request
 * is refused rather than inventing an identity.
 */
function resolveHandlerName(submitted, inv, email) {
  const candidate = String(submitted || inv.recipientName || '').trim();
  if (candidate.length >= 2) return candidate.slice(0, 100);
  const derived = deriveName(email, null);
  if (derived && derived !== 'Staff Member') return derived;
  throw new ApiError(
    422,
    'Please enter your full name to activate this invitation.',
    'VALIDATION_ERROR'
  );
}

/**
 * Safe projection of an invitation for the landing/activation screen.
 * Contains exactly the fields the page renders — never the token hash, never
 * anything that could be replayed as a credential.
 */
async function invitationView(inv) {
  let applicationId = null;
  let applicantName = null;
  // Phase 22.4 — approved workspace identity (stamped on the invitation at
  // approval; application fields cover pre-22.4 invitations). Shown on the
  // activation screen so the recipient sees which shop they are opening.
  let workspaceName = inv.workspaceName || '';
  let workspaceSlug = inv.workspaceSlug || '';
  // HANDLER invitations join the INVITER'S workspace, so the display identity
  // is read from that workspace document (lookup key only — the binding itself
  // is the server-stamped `workspaceId`). This is what lets the activation
  // screen show "Workspace / Business: <name>" before the account exists.
  if (!workspaceName && inv.workspaceId && isValidObjectId(inv.workspaceId)) {
    const ws = await Workspace.findById(inv.workspaceId).select('displayName slug status').lean();
    if (ws) {
      workspaceName = ws.displayName || '';
      workspaceSlug = ws.slug || '';
    }
  }
  if (inv.application && isValidObjectId(inv.application)) {
    const app = await AdminApplication.findById(inv.application)
      .select('applicationId name status businessName proposedSlug')
      .lean();
    if (app) {
      applicationId = app.applicationId || null;
      applicantName = app.name || null;
      if (!workspaceName && app.businessName) workspaceName = app.businessName;
      if (!workspaceSlug && app.proposedSlug) workspaceSlug = app.proposedSlug;
    }
  }
  // Phase 20.6.3 — the person who issued the invitation is shown on the
  // landing screen by name ("Invited by"), which is both friendlier and a
  // real anti-phishing signal: the recipient can sanity-check who asked.
  let invitedByName = '';
  if (inv.inviter && isValidObjectId(inv.inviter)) {
    const inviter = await User.findById(inv.inviter).select('name email').lean();
    if (inviter) invitedByName = inviter.name || inviter.email || '';
  }
  return {
    role: inv.role,
    roleLabel: roleLabel(inv.role),
    recipientEmail: inv.recipientEmail,
    // The invitee's own name (handler invites carry it; admin invites carry
    // it on the linked application instead).
    recipientName: inv.recipientName || applicantName || '',
    department: inv.department || '',
    applicantName,
    applicationId,
    // Workspace identity: approved name/slug for ADMIN invitations (the
    // workspace they will create), the joining workspace for HANDLER invites.
    workspaceName,
    workspaceSlug,
    // GRANULAR STAFF ACCESS — the role template the inviting administrator
    // assigned, so the recipient can see what they are accepting (the
    // permission list itself is applied server-side at activation).
    staffRole: inv.staffRole || null,
    staffRoleLabel: inv.staffRole ? accessRoleLabel(inv.staffRole) : '',
    // Pre-activation identifier, distinct from the account staff id.
    invitationId: `INV-${inv._id.toString().slice(-6).toUpperCase()}`,
    invitedByName,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    status: inv.status,
  };
}

/**
 * Load an invitation by RAW token.
 * Returns { inv } on success or { error: {status, code, message, view?} }.
 * Lazily marks past-due INVITED documents EXPIRED.
 */
async function loadByToken(rawToken) {
  if (!rawToken || !TOKEN_RE.test(String(rawToken))) {
    return { error: { status: 404, code: 'INVITATION_NOT_FOUND', message: 'This invitation link is not valid.' } };
  }
  const tokenHash = sha256(String(rawToken).toLowerCase());
  let inv = await Invitation.findOne({ tokenHash });
  if (!inv) {
    return { error: { status: 404, code: 'INVITATION_NOT_FOUND', message: 'This invitation link is not valid.' } };
  }

  // Lazily expire past-due invitations so the stored state matches reality.
  if (inv.status === 'INVITED' && inv.expiresAt <= new Date()) {
    inv = await Invitation.findOneAndUpdate(
      { _id: inv._id, status: 'INVITED', expiresAt: { $lte: new Date() } },
      { $set: { status: 'EXPIRED' } },
      { new: true }
    );
  }

  if (inv.status === 'EXPIRED') {
    return {
      error: {
        status: 410,
        code: 'INVITATION_EXPIRED',
        message: 'This invitation has expired. Ask the owner to issue a new one.',
        view: await invitationView(inv),
      },
    };
  }
  if (inv.status === 'REVOKED' || inv.status === 'SUSPENDED') {
    return {
      error: {
        status: 403,
        code: 'INVITATION_REVOKED',
        message: 'This invitation has been revoked. Contact the owner for guidance.',
        view: await invitationView(inv),
      },
    };
  }
  if (inv.status === 'ACTIVE' || inv.status === 'ACCEPTED') {
    return {
      error: {
        status: 409,
        code: 'INVITATION_ALREADY_ACTIVATED',
        message: 'This invitation has already been activated. Sign in instead.',
        view: await invitationView(inv),
      },
    };
  }
  return { inv };
}

function sendError(res, error) {
  return res.status(error.status).json({
    success: false,
    message: error.message,
    code: error.code,
    ...(error.view ? { invitation: error.view } : {}),
  });
}

/**
 * GET /api/invitations/:token — landing data for the activation screen.
 * Token possession is the credential; the response carries only the fields
 * the page renders (never the hash, never inviter identity).
 */
export async function getInvitation(req, res, next) {
  try {
    const { inv, error } = await loadByToken(req.params.token);
    if (error) return sendError(res, error);

    // Phase 20.6.6 — the recipient OPENING an approved application's link is
    // the real "invitation delivered" signal. Lazily move the linked
    // application APPROVED → INVITED so the owner's funnel counts (pending /
    // approved / invited / activated) describe reality. Same precedent as
    // the lazy EXPIRED writes; non-critical and idempotent (the guard only
    // matches while the application is still APPROVED).
    if (inv.application && isValidObjectId(inv.application) && inv.status === 'INVITED') {
      await AdminApplication.updateOne(
        { _id: inv.application, status: 'APPROVED' },
        { $set: { status: 'INVITED' } }
      ).catch(() => {});
    }

    res.json({ success: true, invitation: await invitationView(inv) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/invitations/:token/activate — consume the invitation once and
 * create the staff account.
 *
 * Order matters:
 *   1. validate password (before anything is consumed)
 *   2. validate token state
 *   3. check the email is still free — a taken email must NOT burn the token
 *   4. ADMIN invitations branch into services/workspaceProvisioningService:
 *      one transaction consumes the invitation AND creates the Workspace,
 *      the administrator account and the workspace Settings document
 *      (Phase 22.4) — a collision or failure aborts the whole thing, so the
 *      token stays usable for a retry.
 *      HANDLER invitations keep the established path: atomic INVITED →
 *      ACTIVE transition, then User creation (reverted to INVITED if the
 *      insert fails).
 *   5. linked application → ACTIVATED; inviter notified (both non-critical)
 */
export async function activateInvitation(req, res, next) {
  try {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || password.length < MIN_PASSWORD) {
      return res.status(422).json({
        success: false,
        message: `Password must be at least ${MIN_PASSWORD} characters.`,
        code: 'VALIDATION_ERROR',
      });
    }

    const { inv, error } = await loadByToken(req.params.token);
    if (error) return sendError(res, error);

    const email = String(inv.recipientEmail).toLowerCase();

    // A staff account with this email already exists — refuse WITHOUT
    // consuming the invitation (sign-in is the right path there).
    const existing = await User.findOne({ email }).select('_id');
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists. Sign in instead.',
        code: 'EMAIL_TAKEN',
      });
    }

    const application = inv.application && isValidObjectId(inv.application)
      ? await AdminApplication.findById(inv.application)
      : null;

    // ── Phase 22.4 — administrator activation provisions a workspace ────
    if (inv.role === 'admin') {
      const name = deriveName(email, application);
      const passwordHash = await bcrypt.hash(password, 12);
      const suggestedSlug =
        typeof req.body?.workspaceSlug === 'string' ? req.body.workspaceSlug : '';
      const suggestedName =
        typeof req.body?.workspaceName === 'string' ? req.body.workspaceName : '';

      let provisioned;
      try {
        provisioned = await activateAdminInvitation({
          inv,
          application,
          email,
          passwordHash,
          name,
          suggestedSlug,
          suggestedName,
        });
      } catch (err) {
        if (err instanceof ProvisioningError) {
          return res.status(err.status).json({
            success: false,
            message: err.message,
            code: err.code,
          });
        }
        throw err;
      }

      await finishActivation({
        res,
        inv,
        application,
        user: provisioned.user,
        name,
        email,
        workspace: provisioned.workspace,
      });
      return;
    }

    // ── Handler path (unchanged Phase 20.6.2 / 22.2 semantics) ──────────
    // Single-use guarantee: only a document still in INVITED state and not
    // past its TTL can make this transition. Two concurrent activations →
    // exactly one matched update.
    const now = new Date();
    const consumed = await Invitation.findOneAndUpdate(
      { _id: inv._id, status: 'INVITED', expiresAt: { $gt: now } },
      { $set: { status: 'ACTIVE', consumedAt: now } },
      { new: true }
    );
    if (!consumed) {
      const current = await Invitation.findById(inv._id).select('status expiresAt');
      if (current && (current.status === 'EXPIRED' || current.expiresAt <= new Date())) {
        return res.status(410).json({
          success: false,
          message: 'This invitation has expired. Ask the owner to issue a new one.',
          code: 'INVITATION_EXPIRED',
        });
      }
      return res.status(409).json({
        success: false,
        message: 'This invitation has already been activated. Sign in instead.',
        code: 'INVITATION_ALREADY_ACTIVATED',
      });
    }

    // The invited STAFF MEMBER sets their own name on the activation screen.
    // A submitted name wins (that is the point of the form); otherwise the name
    // captured with the invitation is kept; otherwise a readable email form.
    const submittedName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = resolveHandlerName(submittedName, inv, email);
    const passwordHash = await bcrypt.hash(password, 12);

    // GRANULAR STAFF ACCESS — the bundle the inviting administrator chose rides
    // the invitation onto the new account. Absent → the account keeps the
    // legacy implicit full-workspace default (utils/permissions.js).
    const grantedPermissions = Array.isArray(inv.permissions)
      ? normalizePermissions(inv.permissions)
      : inv.staffRole
      ? [...roleTemplate(inv.staffRole)?.permissions || []]
      : undefined;

    let user;
    try {
      // Pre-allocate the id so the derived staff badge (HND-…/ADM-…) can be
      // part of the SAME insert — the identifier the directory shows exists
      // from the account's very first moment, with no follow-up write.
      const newId = new mongoose.Types.ObjectId();
      user = await User.create({
        _id: newId,
        email,
        passwordHash,
        role: inv.role,
        name,
        status: 'ACTIVE',
        isFixture: false,
        isOwner: false, // ownership is granted explicitly, never by invitation
        staffId: staffIdFor(newId, inv.role),
        // Identity captured with the invitation flows onto the account, so the
        // directory does not lose the department/phone the admin typed.
        department: inv.department || '',
        phone: inv.phone || '',
        staffNotes: inv.notes || '',
        invitedBy: inv.inviter || null,
        staffRole: inv.staffRole || null,
        ...(grantedPermissions ? { permissions: grantedPermissions } : {}),
        // Phase 22.2 — workspace membership flows from the INVITATION (which
        // was bound to the inviter's workspace server-side), never from this
        // public request body (client-supplied workspaceId is scrubbed in
        // server.js anyway). Handler invitations carry the workspace; admin
        // invitations take the Phase 22.4 provisioning branch above instead.
        ...(inv.role === 'handler' && inv.workspaceId ? { workspaceId: inv.workspaceId } : {}),
      });
    } catch (err) {
      // Rare race: an account appeared between the check above and create.
      // Give the invitation back so the applicant is not stranded.
      if (err && err.code === 11000) {
        await Invitation.updateOne({ _id: inv._id }, { $set: { status: 'INVITED', consumedAt: null } });
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists. Sign in instead.',
          code: 'EMAIL_TAKEN',
        });
      }
      // Unexpected failure after consumption: revert so the link stays usable.
      await Invitation.updateOne({ _id: inv._id }, { $set: { status: 'INVITED', consumedAt: null } });
      throw err;
    }

    await finishActivation({ res, inv, application, user, name, email });
  } catch (err) {
    next(err);
  }
}

/**
 * Shared activation tail — audit entry, inviter notification and the 201
 * response for BOTH roles. For administrators the optional `workspace`
 * (created inside the provisioning transaction) is echoed so the screen can
 * show which shop is now live.
 */
async function finishActivation({ res, inv, application, user, name, email, workspace = null }) {
  // Non-critical bookkeeping (idempotent for the admin path: the
  // provisioning transaction already moved the dossier to ACTIVATED).
  if (application) {
    await AdminApplication.updateOne(
      { _id: application._id },
      { $set: { status: 'ACTIVATED' } }
    ).catch(() => {});
  }
  // Real audit entry — the activation is the moment the invitation becomes
  // an accountable account, so it belongs on the person's timeline.
  await recordStaffEvent({
    user: user._id,
    staffId: user.staffId,
    recipientEmail: email,
    invitation: inv._id,
    type: 'ACCOUNT_ACTIVATED',
    message: `${name} activated the ${roleLabel(inv.role)} account (${user.staffId}).`,
  });

  const inviter = await User.findById(inv.inviter).select('role').catch(() => null);
  if (inviter) {
    await createNotification({
      userId: inviter._id,
      role: inviter.role,
      type: 'system',
      title: 'Invitation activated',
      message: `${email} activated their ${inv.role} account and can now sign in.`,
      link: inv.role === 'handler' ? '/admin/staff' : '/admin/access',
      // Attribution follows the INVITATION's binding (token-verified here —
      // this public endpoint has no session to derive a workspaceId from).
      workspaceId: getWorkspaceId(inv),
    });
  }

  res.status(201).json({
    success: true,
    message: 'Account activated. You can sign in now.',
    account: {
      email,
      name,
      role: inv.role,
      roleLabel: roleLabel(inv.role),
      staffId: user.staffId,
      department: user.department || '',
      // Display-only workspace context for the portal shell (admin path).
      ...(workspace
        ? { workspace: { slug: workspace.slug, displayName: workspace.displayName } }
        : {}),
    },
    ...(workspace ? { workspace } : {}),
  });
}
