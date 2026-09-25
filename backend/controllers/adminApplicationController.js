import crypto from 'crypto';
import AdminApplication from '../models/AdminApplication.js';
import Invitation, { INVITATION_TTL_HOURS } from '../models/Invitation.js';
import User from '../models/User.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { recordStaffEvent } from '../utils/staffEvents.js';
import { createNotificationsForUsers } from './notificationController.js';
import { activationLink } from './staffInvitationController.js';

/**
 * Phase 20.6.6 — the OWNER ←→ PUBLIC ADMIN APPLICATION flow.
 *
 *   POST  /api/admin-applications                PUBLIC intake (rate-limited)
 *   GET   /api/admin-applications                owner: list + live counts
 *   GET   /api/admin-applications/:id            owner: one dossier
 *   POST  /api/admin-applications/:id/approve    owner: approve + mint invitation
 *   POST  /api/admin-applications/:id/reject     owner: reject (reason required)
 *
 * Security properties:
 *   · submitting creates ONLY an AdminApplication — never a User, never a
 *     credential, never an Invitation, never a JWT. Client-supplied role /
 *     isOwner / status / userId fields are ignored outright; the endpoint
 *     does not read them.
 *   · the owner gates are enforced by protect + requireOwner on the router;
 *     this controller never re-derives authorization from the request.
 *   · APPROVAL is a single MongoDB transaction whose first statement is the
 *     claim gate (SUBMITTED/PENDING_REVIEW → APPROVED). Two concurrent
 *     approvals therefore produce exactly ONE invitation, and the loser
 *     gets a clean 409 instead of a second live credential.
 *   · the invitation role is FIXED to 'admin' — a client can never influence
 *     it, and nothing here accepts a role field at all.
 *   · the raw activation token is returned exactly ONCE, in the approve
 *     response. Only its SHA-256 hash is stored (models/Invitation.js).
 *   · reject-after-approve and approve-after-reject both answer 409: the
 *     review decision is one-way, mirroring the forward-only order lifecycle.
 *
 * Application lifecycle (models/AdminApplication.js):
 *   PENDING_REVIEW → APPROVED → INVITED → ACTIVATED, or → REJECTED.
 *   APPROVED = owner approved, invitation minted, link not yet opened.
 *   INVITED  = the recipient opened the landing link (lazy transition in
 *              invitationController.getInvitation). ACTIVATED is written by
 *              the existing Phase 20.6.2 activation flow.
 *   EXPIRED   = the linked invitation passed its 72h TTL without activation
 *              (lazily reconciled before every owner read).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REVIEWABLE_STATUSES = ['SUBMITTED', 'PENDING_REVIEW'];

/** States that count as a still-open application for duplicate intake. */
const OPEN_STATUSES = ['SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'INVITED'];

function sha256(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function mintToken() {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return { rawToken, tokenHash: sha256(rawToken) };
}

function expiryFromNow() {
  return new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
}

/**
 * Stable public identifier for a dossier. Time-based + random: unique in
 * practice without adding a sequence collection; the unique index on
 * applicationId remains the real guarantee.
 */
function newApplicationId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `APP-${stamp}${suffix}`;
}

/** Presentation shape for an application (public submit + owner views). */
function applicationView(app) {
  const reviewable = REVIEWABLE_STATUSES.includes(app.status);
  return {
    id: String(app._id),
    applicationId: app.applicationId,
    name: app.name,
    email: app.email,
    phone: app.phone || '',
    reason: app.reason,
    background: app.background,
    status: app.status,
    reviewedBy: app.reviewedBy ? String(app.reviewedBy) : null,
    reviewedByName: app.reviewedByName || '',
    reviewedAt: app.reviewedAt || null,
    reviewNote: app.reviewNote || '',
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    // The UI must never offer an action the server would refuse.
    canApprove: reviewable,
    canReject: reviewable,
  };
}

/**
 * Lazily mark applications EXPIRED when their linked invitation died of
 * old age, so the owner's counts describe reality. Same precedent as the
 * lazy EXPIRED write on invitation reads; non-critical by contract.
 */
async function reconcileExpiries() {
  try {
    const dead = await Invitation.find({ status: 'EXPIRED' }).select('application').lean();
    const ids = [...new Set(dead.map((i) => i.application).filter(Boolean).map(String))];
    if (ids.length === 0) return;
    await AdminApplication.updateMany(
      { _id: { $in: ids }, status: { $in: ['APPROVED', 'INVITED'] } },
      { $set: { status: 'EXPIRED' } }
    );
  } catch {
    /* non-critical — counts stay honest on the next read */
  }
}

/**
 * POST /api/admin-applications — PUBLIC intake.
 *
 * Creates an application record and nothing else. Validation happens before
 * any write; the duplicate check is check-then-insert on purpose (a unique
 * index on email would forbid the legitimate "rejected → re-apply" path), so
 * a race can at worst create a second dossier — never an account or a
 * credential.
 */
export async function submitApplication(req, res, next) {
  try {
    const body = req.body || {};
    // Deliberately never read: role, isOwner, status, userId, password.
    const name = safeString(body.name, 100).trim();
    const email = safeString(body.email, 200).trim().toLowerCase();
    const phone = safeString(body.phone, 30).trim();
    const reason = safeString(body.reason, 2000).trim();
    const background = safeString(body.background, 2000).trim();

    if (name.length < 2) {
      throw new ApiError(422, 'Please provide your full name.', 'VALIDATION_ERROR');
    }
    if (!EMAIL_RE.test(email)) {
      throw new ApiError(422, 'Please provide a valid work email address.', 'VALIDATION_ERROR');
    }
    if (phone && phone.replace(/\D/g, '').length > 15) {
      throw new ApiError(422, 'Please provide a valid phone number.', 'VALIDATION_ERROR');
    }
    if (reason.length < 10) {
      throw new ApiError(
        422,
        'Please tell us why you want to join (at least 10 characters).',
        'VALIDATION_ERROR'
      );
    }
    if (background.length < 10) {
      throw new ApiError(
        422,
        'Please describe your professional background (at least 10 characters).',
        'VALIDATION_ERROR'
      );
    }

    const open = await AdminApplication.findOne({ email, status: { $in: OPEN_STATUSES } })
      .select('_id applicationId')
      .lean();
    if (open) {
      throw new ApiError(
        409,
        'You already have an application awaiting review. The owner will get back to you.',
        'DUPLICATE_APPLICATION'
      );
    }

    const application = await AdminApplication.create({
      applicationId: newApplicationId(),
      name,
      email,
      phone,
      reason,
      background,
      status: 'PENDING_REVIEW',
    });

    // Non-critical: every active owner hears about the new dossier. No
    // secrets in the payload — name, email and the applications link only.
    const owners = await User.find({ role: 'admin', isOwner: true, status: 'ACTIVE' })
      .select('_id role')
      .lean();
    await createNotificationsForUsers(owners, {
      role: 'admin',
      type: 'system',
      title: 'New administrator application',
      message: `${name} (${email}) applied to join the staff console.`,
      link: '/admin/applications',
    });

    await recordStaffEvent({
      recipientEmail: email,
      type: 'ADMIN_APPLICATION_SUBMITTED',
      message: `${name} (${email}) submitted an administrator application (${application.applicationId}).`,
    });

    res.status(201).json({
      success: true,
      message:
        'Application received. The owner reviews every submission personally — you will hear from us.',
      application: applicationView(application),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin-applications — owner review list.
 *
 * `status` is a tab filter (PENDING maps to the two intake states), `q`
 * searches name/email/applicationId with regex escaping, `page`/`limit`
 * paginate (limit capped). `counts` always describes the WHOLE ledger, not
 * the filtered page, so the tabs and the owner dashboard KPIs are real.
 */
export async function listApplications(req, res, next) {
  try {
    await reconcileExpiries();

    const status = safeString(req.query.status, 20).toUpperCase();
    const q = safeString(req.query.q, 200);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));

    const match = {};
    if (status && status !== 'ALL') {
      if (status === 'PENDING') match.status = { $in: REVIEWABLE_STATUSES };
      else match.status = status;
    }
    if (q) {
      const regex = new RegExp(escapeRegExp(q), 'i');
      match.$or = [{ name: regex }, { email: regex }, { applicationId: regex }];
    }

    const [total, applications] = await Promise.all([
      AdminApplication.countDocuments(match),
      AdminApplication.find(match)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const [all, pending, approved, invited, activated, rejected, expired] = await Promise.all([
      AdminApplication.countDocuments({}),
      AdminApplication.countDocuments({ status: { $in: REVIEWABLE_STATUSES } }),
      AdminApplication.countDocuments({ status: 'APPROVED' }),
      AdminApplication.countDocuments({ status: 'INVITED' }),
      AdminApplication.countDocuments({ status: 'ACTIVATED' }),
      AdminApplication.countDocuments({ status: 'REJECTED' }),
      AdminApplication.countDocuments({ status: 'EXPIRED' }),
    ]);

    res.json({
      success: true,
      applications: applications.map(applicationView),
      counts: { all, pending, approved, invited, activated, rejected, expired },
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin-applications/:id — one dossier (+ live invitation state). */
export async function getApplicationById(req, res, next) {
  try {
    await reconcileExpiries();
    const app = await AdminApplication.findById(req.params.id).lean();
    if (!app) throw new ApiError(404, 'Application not found.', 'NOT_FOUND');

    // For a live application, show the linked invitation's REAL state — but
    // never a token: reads cannot leak a credential (the raw link exists
    // only in the approve response that minted it).
    let invitation = null;
    if (app.status === 'APPROVED' || app.status === 'INVITED' || app.status === 'EXPIRED') {
      const inv = await Invitation.findOne({ application: app._id })
        .sort({ createdAt: -1 })
        .lean();
      if (inv) {
        invitation = {
          invitationId: `INV-${String(inv._id).slice(-6).toUpperCase()}`,
          status: inv.status,
          expiresAt: inv.expiresAt,
          consumedAt: inv.consumedAt || null,
          resendCount: inv.resendCount || 0,
        };
      }
    }

    res.json({ success: true, application: applicationView(app), invitation });
  } catch (err) {
    next(err);
  }
}

/**
 * Approve inside ONE MongoDB transaction.
 *
 * The claim gate is the first write, so approval is one-way and
 * single-winner: the guarded findOneAndUpdate matches only while the
 * application is still SUBMITTED/PENDING_REVIEW. Concurrent owners (or a
 * double click) produce exactly one matched update; the loser aborts with
 * 409 and no second invitation ever exists.
 *
 * Order (mirrors the documented activation flow):
 *   1. validate the optional approval note
 *   2. claim: → APPROVED + review metadata (THE race gate)
 *   3. refuse if the email already has an account (token stays unconsumed
 *      because the transaction aborts — the application remains reviewable)
 *   4. mint the admin invitation (role FIXED to 'admin', application linked)
 *   5. commit — then record audit events and return the raw link ONCE
 */
async function approveOnce(req) {
  const note = safeString(req.body?.note, 2000).trim();
  const session = await AdminApplication.startSession();
  let claimed;
  try {
    session.startTransaction();

    claimed = await AdminApplication.findOneAndUpdate(
      { _id: req.params.id, status: { $in: REVIEWABLE_STATUSES } },
      {
        $set: {
          status: 'APPROVED',
          reviewedBy: req.user._id,
          reviewedByName: req.user.name || req.user.email || '',
          reviewedAt: new Date(),
          reviewNote: note,
        },
      },
      { new: true, session }
    );

    if (!claimed) {
      const current = await AdminApplication.findById(req.params.id).session(session).lean();
      if (!current) {
        throw new ApiError(404, 'Application not found.', 'NOT_FOUND');
      }
      if (current.status === 'REJECTED') {
        throw new ApiError(
          409,
          'This application was rejected and can no longer be approved.',
          'APPLICATION_REJECTED'
        );
      }
      throw new ApiError(
        409,
        'This application has already been approved.',
        'ALREADY_APPROVED'
      );
    }

    // A staff account with this email must not exist — approval would mint a
    // link the recipient could never use (activation refuses taken emails).
    // Aborting the transaction rolls the claim back, so the owner can retry
    // after the conflict is resolved.
    const existingUser = await User.findOne({ email: claimed.email })
      .session(session)
      .select('_id');
    if (existingUser) {
      throw new ApiError(
        409,
        'An account with this email already exists — this application cannot be invited.',
        'EMAIL_TAKEN'
      );
    }

    const { rawToken, tokenHash } = mintToken();
    await Invitation.create(
      [
        {
          recipientEmail: claimed.email,
          recipientName: claimed.name,
          phone: claimed.phone || '',
          role: 'admin', // FIXED — never client-supplied
          inviter: req.user._id,
          application: claimed._id,
          tokenHash,
          expiresAt: expiryFromNow(),
          status: 'INVITED',
          lastSentAt: new Date(),
        },
      ],
      { session }
    );

    await session.commitTransaction();
    return { applicationId: claimed._id, rawToken };
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    throw err;
  } finally {
    session.endSession();
  }
}

/** MongoDB write-conflict raised at the transaction level (see orderService). */
function isTransientTxConflict(err) {
  if (!err) return false;
  if (err.code === 112 || err.code === 11000) return true;
  const labels = err.errorLabels || (err.errorResponse && err.errorResponse.errorLabels);
  return Array.isArray(labels) && labels.includes('TransientTransactionError');
}

async function approveWithRetry(req) {
  try {
    return await approveOnce(req);
  } catch (err) {
    if (!isTransientTxConflict(err)) throw err;
  }
  try {
    return await approveOnce(req);
  } catch (err) {
    if (!isTransientTxConflict(err)) throw err;
  }
  throw new ApiError(
    409,
    'This application was being reviewed at the same moment — refresh and try again.',
    'CONFLICT'
  );
}

/** POST /api/admin-applications/:id/approve — owner approves, link returned once. */
export async function approveApplication(req, res, next) {
  try {
    const { applicationId, rawToken } = await approveWithRetry(req);

    const application = await AdminApplication.findById(applicationId).lean();
    if (!application) throw new ApiError(404, 'Application not found.', 'NOT_FOUND');
    const invitation = await Invitation.findOne({ application: applicationId })
      .sort({ createdAt: -1 })
      .lean();

    const actorName = req.user.name || req.user.email || 'Owner';

    // Audit: the review decision AND the credential mint are distinct
    // lifecycle facts (same pairing the handler-invite path records).
    await recordStaffEvent({
      recipientEmail: application.email,
      type: 'ADMIN_APPLICATION_APPROVED',
      message: `${actorName} approved ${application.name} (${application.email}) — application ${application.applicationId}.`,
      actor: req.user,
    });
    await recordStaffEvent({
      recipientEmail: application.email,
      invitation: invitation ? invitation._id : null,
      type: 'INVITATION_CREATED',
      message: `${actorName} invited ${application.email} as an Administrator via approved application ${application.applicationId}.`,
      actor: req.user,
    });

    res.json({
      success: true,
      message: `Application approved. One-time invitation created for ${application.email}.`,
      application: applicationView(application),
      // The ONE and ONLY time this token is ever returned.
      link: activationLink(rawToken),
      invitation: invitation
        ? {
            invitationId: `INV-${String(invitation._id).slice(-6).toUpperCase()}`,
            status: invitation.status,
            expiresAt: invitation.expiresAt,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin-applications/:id/reject — owner rejects (reason required). */
export async function rejectApplication(req, res, next) {
  try {
    const reason = safeString(req.body?.reason, 2000).trim();
    if (reason.length < 10) {
      throw new ApiError(
        422,
        'Please provide a rejection reason (at least 10 characters).',
        'VALIDATION_ERROR'
      );
    }

    // Single atomic claim — no transaction needed for a one-document update.
    const claimed = await AdminApplication.findOneAndUpdate(
      { _id: req.params.id, status: { $in: REVIEWABLE_STATUSES } },
      {
        $set: {
          status: 'REJECTED',
          reviewedBy: req.user._id,
          reviewedByName: req.user.name || req.user.email || '',
          reviewedAt: new Date(),
          reviewNote: reason,
        },
      },
      { new: true }
    );

    if (!claimed) {
      const current = await AdminApplication.findById(req.params.id).lean();
      if (!current) throw new ApiError(404, 'Application not found.', 'NOT_FOUND');
      if (current.status === 'REJECTED') {
        throw new ApiError(409, 'This application has already been rejected.', 'ALREADY_REJECTED');
      }
      throw new ApiError(
        409,
        'This application was already approved — revoke its invitation instead.',
        'APPLICATION_APPROVED'
      );
    }

    await recordStaffEvent({
      recipientEmail: claimed.email,
      type: 'ADMIN_APPLICATION_REJECTED',
      message: `${req.user.name || req.user.email} rejected ${claimed.name} (${claimed.email}) — application ${claimed.applicationId}.`,
      actor: req.user,
    });

    res.json({
      success: true,
      message: `Application ${claimed.applicationId} rejected.`,
      application: applicationView(claimed),
    });
  } catch (err) {
    next(err);
  }
}
