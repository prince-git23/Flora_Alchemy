import Workspace from '../models/Workspace.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { SLUG_RE } from '../utils/workspaceSlug.js';

/**
 * Phase 22.4 — PUBLIC shop directory read.
 *
 * GET /api/shops/:slug → the ACTIVE workspace behind a public shop URL.
 * Tokenless by design (anyone may discover which shop a slug names — the
 * same information the rendered storefront would show), so the query is
 * deliberately NOT workspace-scoped: the slug IS the tenant key here, and
 * the only rows it can ever return are ACTIVE workspaces' public identity.
 * Orders, catalogue mutations, settings and everything else remain behind
 * their own gates (Phase 22.5 hydrates per-shop catalogue reads).
 */
export async function getShopProfile(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    const workspace = await Workspace.findOne({ slug, status: 'ACTIVE' })
      .select('slug displayName')
      .lean();
    if (!workspace) {
      throw new ApiError(404, 'Shop not found.', 'SHOP_NOT_FOUND');
    }
    res.json({
      success: true,
      shop: { slug: workspace.slug, displayName: workspace.displayName },
    });
  } catch (err) {
    next(err);
  }
}
