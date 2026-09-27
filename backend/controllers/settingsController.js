import Settings from '../models/Settings.js';
import { cached, cacheInvalidatePrefix } from '../utils/publicCache.js';
import { getWorkspaceId } from '../utils/tenancy.js';
import { catalogueContext } from '../utils/catalogueContext.js';

const ALLOWED_TOP = [
  'storeName',
  'currency',
  'storeAvailability',
  'acceptNewOrders',
  'shippingConfiguration',
  'customGiftConfiguration',
  'storeTagline',
  'contactEmail',
  'contactPhone',
  'timezone',
  'commerceConfiguration',
  'notificationConfiguration',
];

/** The pre-migration singleton that backs the shared storefront. */
async function legacySettings() {
  const settings = await Settings.findOne({
    // Unscoped on purpose: this IS the shared document the storefront reads.
    key: 'default',
  });
  if (settings) return settings;
  return Settings.create({ key: 'default' });
}

/**
 * Resolve the document a WORKSPACE write acts on (Phase 22.3 §10).
 *
 * A workspace owns its own settings document (`key = workspaceSlug`,
 * `workspaceId` set). On the FIRST write it is cloned from the legacy
 * singleton, so a newly onboarded workspace starts from today's store
 * configuration instead of schema defaults. The singleton itself is never
 * touched by a workspace — one tenant's shipping rates cannot leak into
 * another's order flow.
 */
async function workspaceSettings(req, workspaceId) {
  const own = await Settings.findOne({ workspaceId });
  if (own) return own;
  const seed = await legacySettings();
  const seedDoc = seed.toObject();
  for (const field of ['_id', '__v', 'key', 'workspaceId', 'createdAt', 'updatedAt']) {
    delete seedDoc[field];
  }
  return Settings.create({
    ...seedDoc,
    key: req.workspaceSlug || `workspace-${workspaceId}`,
    workspaceId,
    isFixture: false,
  });
}

export async function getSettings(req, res, next) {
  try {
    // Public storefront settings: read on every hydration, rarely change.
    // 30s TTL + invalidation on PATCH (Phase 17). A staff token gets ITS
    // workspace's document when one exists; everyone else (storefront,
    // customers, no token) reads the shared singleton — the storefront has
    // no workspace context in Phase 22.3.
    const ctx = await catalogueContext(req);
    const staffWorkspaceId = ctx.staff ? getWorkspaceId(ctx.user) : null;
    if (staffWorkspaceId) {
      const own = await Settings.findOne({ workspaceId: staffWorkspaceId });
      if (own) {
        res.json({ success: true, settings: own });
        return;
      }
    }
    const settings = await cached('settings:default', legacySettings, Settings);
    res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
}

export async function updateSettings(req, res, next) {
  try {
    // Owner = platform-wide configuration (legacy singleton); a workspace
    // admin can only ever patch its OWN document (req.workspaceId comes from
    // the gate's membership check, never from the body — which is scrubbed).
    const workspaceId = req.workspacePlatform ? null : (req.workspaceId || null);
    const settings = workspaceId
      ? await workspaceSettings(req, workspaceId)
      : await legacySettings();
    for (const field of ALLOWED_TOP) {
      if (req.body[field] !== undefined) {
        settings[field] = req.body[field];
      }
    }
    await settings.save();
    cacheInvalidatePrefix('settings:');
    res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
}
