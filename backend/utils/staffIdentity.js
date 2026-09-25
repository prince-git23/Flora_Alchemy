/**
 * Phase 20.6.3 / 20.6.4 — staff identity helpers.
 *
 * There is no counter/sequence infrastructure in this project, and adding one
 * would mean a new collection plus a migration for existing accounts. Instead
 * the "staff ID" shown in the directory (HND-1A2B3C) is DERIVED from the
 * document's own ObjectId: deterministic, collision-free in practice at 6 hex
 * characters (16.7M values) for the staff population this system manages, and
 * impossible to guess a *different* account's ID from.
 *
 * The value is stored on the User at creation (see staffIdFor use in the
 * activation/creation paths) so it stays stable forever, but `staffIdFor` can
 * always recompute the same value from the id.
 */

const PREFIX = { admin: 'ADM', handler: 'HND', customer: 'CUS' };

/**
 * Derive the display staff id.
 * @param {object|string} docOrId  a Mongoose document (uses ._id) or an id string
 * @param {string} role            'admin' | 'handler' | 'customer'
 * @param {boolean} isOwner        owner accounts get the OWN prefix
 */
export function staffIdFor(docOrId, role, isOwner = false) {
  const raw = typeof docOrId === 'string' ? docOrId : String(docOrId?._id || '');
  const hex = raw.replace(/[^a-f0-9]/gi, '').toUpperCase();
  // Last 6 hex characters of an ObjectId are the "random" counter part, so
  // sequential ids never produce sequential-looking staff ids.
  const tail = (hex.slice(-6) || '000000').padStart(6, '0');
  const prefix = isOwner ? 'OWN' : PREFIX[role] || 'STF';
  return `${prefix}-${tail}`;
}

/** Up-to-two-letter initials for avatars (never invents a name). */
export function initialsOf(name, email) {
  const source = String(name || email || '').trim();
  if (!source) return 'FA';
  const parts = source.includes('@') ? [source.split('@')[0]] : source.split(/[\s._-]+/);
  const letters = parts.filter(Boolean).slice(0, 2).map((p) => p[0]);
  return (letters.join('') || 'FA').toUpperCase();
}

/** Human relative time ("Just now", "3h ago", "12 Sep 2026"). */
export function relativeTime(date) {
  if (!date) return 'Never';
  const diff = Date.now() - new Date(date).getTime();
  if (Number.isNaN(diff)) return 'Never';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * The canonical role label used across the staff UI. Degrades gracefully and
 * never leaks the raw enum ('admin' → 'Administrator').
 */
export function roleLabel(role, isOwner = false) {
  if (role === 'admin') return isOwner ? 'Owner' : 'Administrator';
  if (role === 'handler') return 'Handler';
  if (role === 'customer') return 'Customer';
  return 'Staff';
}

/** Uppercase badge form of the role label ('ADMINISTRATOR' / 'HANDLER'). */
export function roleBadge(role, isOwner = false) {
  return roleLabel(role, isOwner).toUpperCase();
}
