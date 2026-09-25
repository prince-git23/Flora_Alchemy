import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Invitation from '../models/Invitation.js';
import AdminApplication from '../models/AdminApplication.js';
import User from '../models/User.js';
import { createNotification } from './notificationController.js';
import { staffIdFor, roleLabel } from '../utils/staffIdentity.js';
import { recordStaffEvent } from '../utils/staffEvents.js';

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
 * Safe projection of an invitation for the landing/activation screen.
 * Contains exactly the fields the page renders — never the token hash, never
 * anything that could be replayed as a credential.
 */
async function invitationView(inv) {
  let applicationId = null;
  let applicantName = null;
  if (inv.application && isValidObjectId(inv.application)) {
    const app = await AdminApplication.findById(inv.application)
      .select('applicationId name status')
      .lean();
    if (app) {
      applicationId = app.applicationId || null;
      applicantName = app.name || null;
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
 *   4. ATOMIC INVITED → ACTIVE transition (the single-use guarantee)
 *   5. create the User; if creation fails after consumption, the token is
 *      reverted to INVITED so the applicant is not stranded
 *   6. linked application → ACTIVATED; inviter notified (both non-critical)
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

    const application = inv.application && isValidObjectId(inv.application)
      ? await AdminApplication.findById(inv.application)
      : null;
    const name = deriveName(email, application);
    const passwordHash = await bcrypt.hash(password, 12);

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

    // Non-critical bookkeeping.
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
      },
    });
  } catch (err) {
    next(err);
  }
}
