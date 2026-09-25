import StaffEvent from '../models/StaffEvent.js';

/**
 * Phase 20.6.4 — staff audit helpers.
 *
 * `recordStaffEvent` is intentionally failure-tolerant: an audit write must
 * never break the business operation that triggered it (the same contract as
 * createNotification). Every lifecycle point calls it AFTER the real state
 * change has succeeded, so the ledger can only ever under-report, never
 * invent an event that did not happen.
 */
export async function recordStaffEvent({
  user = null,
  staffId = null,
  recipientEmail = null,
  invitation = null,
  type,
  message = '',
  actor = null,
  at = new Date(),
}) {
  try {
    return await StaffEvent.create({
      user: user || null,
      staffId: staffId || null,
      recipientEmail: recipientEmail ? String(recipientEmail).toLowerCase() : null,
      invitation: invitation || null,
      type,
      message,
      actor: actor ? actor._id || actor : null,
      actorName: actor ? actor.name || actor.email || '' : '',
      at,
    });
  } catch {
    return null; // Non-critical — never break the caller.
  }
}

/**
 * Timeline for one staff member, newest first.
 *
 * Matches on the user id when the account exists, and always on the email so
 * pre-activation events (invitation created/resent/revoked) appear in the same
 * stream as post-activation ones. An optional invitation id picks up events
 * that predate the account and have no email match (defensive).
 */
export async function loadStaffTimeline({ userId, email, invitationId = null, limit = 50 }) {
  const or = [];
  if (userId) or.push({ user: userId });
  if (email) or.push({ recipientEmail: String(email).toLowerCase() });
  if (invitationId) or.push({ invitation: invitationId });
  if (or.length === 0) return [];
  return StaffEvent.find({ $or: or })
    .sort({ at: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .select('type message actorName at staffId')
    .lean();
}
