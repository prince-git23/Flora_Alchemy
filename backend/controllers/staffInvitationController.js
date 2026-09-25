import crypto from 'crypto';
import Invitation, { INVITATION_TTL_HOURS } from '../models/Invitation.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { staffIdFor, roleLabel, relativeTime } from '../utils/staffIdentity.js';
import { recordStaffEvent } from '../utils/staffEvents.js';

/**
 * Phase 20.6.3 — handler invitation management (staff-side, authenticated).
 *
 * The PUBLIC half of the invitation lifecycle (landing + activation) already
 * exists in invitationController.js (Phase 20.6.2) and is NOT duplicated here.
 * This controller owns everything an administrator does to an invitation:
 *
 *   POST   /api/admin/invitations            issue a HANDLER invitation
 *   GET    /api/admin/invitations            list + status counts
 *   GET    /api/admin/invitations/:id        one invitation (no raw token)
 *   POST   /api/admin/invitations/:id/resend mint a fresh token, extend TTL
 *   POST   /api/admin/invitations/:id/revoke withdraw an unused invitation
 *
 * Security properties:
 *   · the raw token is generated with crypto.randomBytes(32) and appears in
 *     exactly ONE response — the create or the resend that minted it. It is
 *     never stored (only its SHA-256 hash), never logged, and never returned
 *     by any read endpoint. The UI reflects this honestly: "Copy link" is
 *     only offered for a link that was just minted in this session.
 *   · resending replaces the stored hash, so the previously emailed or copied
 *     link is invalidated rather than lingering as a second live credential.
 *   · the role is FIXED to 'handler' here. A client-supplied role is rejected
 *     rather than ignored, so this endpoint can never be mistaken for a way to
 *     mint an administrator.
 *   · handler invitations require an admin session (router-enforced); the
 *     invitation endpoints deliberately accept no owner-only escalation.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Base URL the invitation link points at (the staff portal). */
function portalBase() {
  return (
    process.env.STAFF_PORTAL_URL ||
    process.env.CLIENT_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** Mint a new raw token; returns { rawToken, tokenHash }. */
function mintToken() {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return { rawToken, tokenHash: sha256(rawToken) };
}

export function activationLink(rawToken) {
  return `${portalBase()}/admin/activate/${rawToken}`;
}

function expiryFromNow() {
  return new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
}

/**
 * Presentation shape for an invitation. Deliberately contains no tokenHash
 * and no raw token — reads cannot leak a credential.
 */
function invitationView(inv, inviterName = '') {
  const isExpired = inv.status === 'INVITED' && inv.expiresAt <= new Date();
  return {
    id: inv._id.toString(),
    recipientName: inv.recipientName || '',
    recipientEmail: inv.recipientEmail,
    role: inv.role,
    roleLabel: roleLabel(inv.role),
    // Pre-activation badge id, derived from the invitation document. The
    // ACCOUNT gets its own staff id (HND-…) once it exists — these are two
    // different identifiers and the UI labels them as such ("Invitation ID"
    // vs "Staff ID") rather than pretending they are the same thing.
    invitationId: `INV-${inv._id.toString().slice(-6).toUpperCase()}`,
    department: inv.department || '',
    phone: inv.phone || '',
    notes: inv.notes || '',
    status: isExpired ? 'EXPIRED' : inv.status,
    storedStatus: inv.status,
    invitedByName: inviterName || '',
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    lastSentAt: inv.lastSentAt || inv.createdAt,
    resendCount: inv.resendCount || 0,
    consumedAt: inv.consumedAt || null,
    revokedAt: inv.revokedAt || null,
    revokeReason: inv.revokeReason || '',
    expiresIn: relativeTime(inv.expiresAt),
    // Actionable state (the UI must not offer an action the server refuses).
    canResend: (inv.status === 'INVITED' || isExpired) && !inv.consumedAt,
    canRevoke: (inv.status === 'INVITED' || isExpired) && !inv.consumedAt,
  };
}

/**
 * Lazily reconcile stored status with reality before any read. One bulk write
 * keeps the ledger honest instead of a per-document check.
 */
async function reconcileExpiries() {
  await Invitation.updateMany(
    { status: 'INVITED', expiresAt: { $lte: new Date() } },
    { $set: { status: 'EXPIRED' } }
  ).catch(() => {});
}

async function inviterNames(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const users = await User.find({ _id: { $in: unique } }).select('name email').lean();
  return new Map(users.map((u) => [String(u._id), u.name || u.email]));
}

/** GET /api/admin/invitations — list with filters and status counts. */
export async function listInvitations(req, res, next) {
  try {
    await reconcileExpiries();

    const status = safeString(req.query.status, 20).toUpperCase();
    const q = safeString(req.query.q, 200);
    const role = safeString(req.query.role, 20).toLowerCase();

    const match = {};
    if (role === 'admin' || role === 'handler') match.role = role;
    if (status && status !== 'ALL') {
      if (status === 'PENDING') match.status = 'INVITED';
      // "Accepted" covers both stored terminal states of a consumed
      // invitation (ACCEPTED is written by older flows, ACTIVE by activation),
      // so the tab reflects reality instead of one spelling of it.
      else if (status === 'ACCEPTED') match.status = { $in: ['ACCEPTED', 'ACTIVE'] };
      else if (['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED'].includes(status)) {
        match.status = status;
      }
    }
    if (q) {
      const regex = new RegExp(escapeRegExp(q), 'i');
      match.$or = [{ recipientEmail: regex }, { recipientName: regex }, { department: regex }];
    }

    const invitations = await Invitation.find(match)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const names = await inviterNames(invitations.map((i) => i.inviter));

    // Counts describe the WHOLE ledger, not the filtered page.
    const [pending, accepted, expired, revoked, activated] = await Promise.all([
      Invitation.countDocuments({ status: 'INVITED' }),
      Invitation.countDocuments({ status: 'ACCEPTED' }),
      Invitation.countDocuments({ status: 'EXPIRED' }),
      Invitation.countDocuments({ status: 'REVOKED' }),
      Invitation.countDocuments({ status: 'ACTIVE' }),
    ]);

    res.json({
      success: true,
      invitations: invitations.map((i) => invitationView(i, names.get(String(i.inviter)))),
      counts: {
        all: pending + accepted + expired + revoked + activated,
        pending,
        accepted: accepted + activated,
        expired,
        revoked,
      },
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/invitations/:id */
export async function getInvitationById(req, res, next) {
  try {
    await reconcileExpiries();
    const inv = await Invitation.findById(req.params.id).lean();
    if (!inv) throw new ApiError(404, 'Invitation not found.', 'NOT_FOUND');
    const names = await inviterNames([inv.inviter]);
    res.json({ success: true, invitation: invitationView(inv, names.get(String(inv.inviter))) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/invitations — issue a HANDLER invitation.
 *
 * Duplicate handling is explicit and ordered: an existing ACCOUNT answers 409
 * EMAIL_TAKEN (inviting an existing user is never right), a live pending
 * INVITATION answers 409 INVITATION_PENDING (resend it instead of minting a
 * second live credential).
 */
export async function createHandlerInvitation(req, res, next) {
  try {
    const body = req.body || {};
    const name = safeString(body.name, 100).trim();
    const email = safeString(body.email, 200).trim().toLowerCase();
    const phone = safeString(body.phone, 30).trim();
    const department = safeString(body.department, 120).trim();
    const notes = safeString(body.notes, 500).trim();

    // The role is fixed by the endpoint's purpose. A request that asks for
    // anything else is rejected outright, not silently coerced — this endpoint
    // exists to create HANDLERS.
    if (body.role !== undefined && body.role !== null && String(body.role).toLowerCase() !== 'handler') {
      throw new ApiError(
        422,
        'This endpoint issues Handler invitations only.',
        'VALIDATION_ERROR'
      );
    }
    if (name.length < 2) {
      throw new ApiError(422, 'Please provide the handler’s full name.', 'VALIDATION_ERROR');
    }
    if (!EMAIL_RE.test(email)) {
      throw new ApiError(422, 'Please provide a valid work email address.', 'VALIDATION_ERROR');
    }
    if (phone && String(phone).replace(/\D/g, '').length > 15) {
      throw new ApiError(422, 'Please provide a valid phone number.', 'VALIDATION_ERROR');
    }

    const existingUser = await User.findOne({ email }).select('_id role');
    if (existingUser) {
      throw new ApiError(
        409,
        'A staff account with this email already exists.',
        'EMAIL_TAKEN'
      );
    }

    await reconcileExpiries();
    const pending = await Invitation.findOne({ recipientEmail: email, status: 'INVITED' }).select('_id expiresAt');
    if (pending) {
      throw new ApiError(
        409,
        'An invitation for this email is already pending. Resend it instead.',
        'INVITATION_PENDING'
      );
    }

    const { rawToken, tokenHash } = mintToken();
    const inv = await Invitation.create({
      recipientEmail: email,
      recipientName: name,
      phone,
      department,
      notes,
      role: 'handler',
      inviter: req.user._id,
      tokenHash,
      expiresAt: expiryFromNow(),
      status: 'INVITED',
      lastSentAt: new Date(),
    });

    await recordStaffEvent({
      recipientEmail: email,
      invitation: inv._id,
      type: 'INVITATION_CREATED',
      message: `${req.user.name || req.user.email} invited ${name} (${email}) as a Handler${department ? ` · ${department}` : ''}.`,
      actor: req.user,
    });

    // The ONE and ONLY time this token is ever returned.
    res.status(201).json({
      success: true,
      message: `Invitation issued to ${email}.`,
      link: activationLink(rawToken),
      invitation: invitationView(inv, req.user.name || req.user.email),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/invitations/:id/resend
 *
 * Mints a NEW token and pushes the TTL out. The previously issued link is
 * invalidated by overwriting the stored hash — a resend must not leave two
 * live credentials for the same person.
 */
export async function resendInvitation(req, res, next) {
  try {
    const inv = await Invitation.findById(req.params.id);
    if (!inv) throw new ApiError(404, 'Invitation not found.', 'NOT_FOUND');
    if (inv.consumedAt || inv.status === 'ACTIVE' || inv.status === 'ACCEPTED') {
      throw new ApiError(409, 'This invitation has already been activated.', 'INVITATION_ALREADY_ACTIVATED');
    }
    if (inv.status === 'REVOKED') {
      throw new ApiError(422, 'This invitation was revoked. Issue a new one instead.', 'INVITATION_REVOKED');
    }

    const { rawToken, tokenHash } = mintToken();
    inv.tokenHash = tokenHash;
    inv.expiresAt = expiryFromNow();
    inv.status = 'INVITED';
    inv.lastSentAt = new Date();
    inv.resendCount = (inv.resendCount || 0) + 1;
    await inv.save();

    await recordStaffEvent({
      recipientEmail: inv.recipientEmail,
      invitation: inv._id,
      type: 'INVITATION_RESENT',
      message: `${req.user.name || req.user.email} resent the invitation to ${inv.recipientEmail}; the previous link was invalidated.`,
      actor: req.user,
    });

    res.json({
      success: true,
      message: `Invitation re-sent to ${inv.recipientEmail}. The previous link no longer works.`,
      link: activationLink(rawToken),
      invitation: invitationView(inv, req.user.name || req.user.email),
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/invitations/:id/revoke — withdraw an unused invitation. */
export async function revokeInvitation(req, res, next) {
  try {
    const inv = await Invitation.findById(req.params.id);
    if (!inv) throw new ApiError(404, 'Invitation not found.', 'NOT_FOUND');
    if (inv.consumedAt || inv.status === 'ACTIVE' || inv.status === 'ACCEPTED') {
      throw new ApiError(
        409,
        'This invitation has already been activated — suspend the account instead.',
        'INVITATION_ALREADY_ACTIVATED'
      );
    }
    if (inv.status === 'REVOKED') {
      // Idempotent: revoking twice is not an error, and the second call must
      // not overwrite who actually revoked it.
      return res.json({
        success: true,
        message: 'This invitation was already revoked.',
        invitation: invitationView(inv, req.user.name || req.user.email),
      });
    }

    const reason = safeString(req.body?.reason, 300).trim();
    inv.status = 'REVOKED';
    inv.revokedAt = new Date();
    inv.revokedBy = req.user._id;
    inv.revokeReason = reason;
    await inv.save();

    await recordStaffEvent({
      recipientEmail: inv.recipientEmail,
      invitation: inv._id,
      type: 'INVITATION_REVOKED',
      message: `${req.user.name || req.user.email} revoked the invitation for ${inv.recipientEmail}${reason ? `: ${reason}` : '.'}`,
      actor: req.user,
    });

    res.json({
      success: true,
      message: `Invitation for ${inv.recipientEmail} revoked.`,
      invitation: invitationView(inv, req.user.name || req.user.email),
    });
  } catch (err) {
    next(err);
  }
}
