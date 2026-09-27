import Inventory from '../models/Inventory.js';
import InventoryMovement from '../models/InventoryMovement.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { adjustStock } from '../services/inventoryService.js';
import { getWorkspaceId, requestScope } from '../utils/tenancy.js';

export async function overview(req, res, next) {
  try {
    const docs = await Inventory.find({ ...requestScope(req) }).sort({ productName: 1 });
    res.json({
      success: true,
      inventory: docs,
      summary: {
        totalItems: docs.length,
        lowStock: docs.filter((d) => d.currentStock > 0 && d.currentStock <= d.reorderLevel).length,
        outOfStock: docs.filter((d) => d.currentStock <= 0).length,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function byProduct(req, res, next) {
  try {
    const doc = await Inventory.findOne({
      productSlug: req.params.productId,
      ...requestScope(req),
    });
    if (!doc) {
      throw new ApiError(404, 'No inventory record for this product.', 'NOT_FOUND');
    }
    res.json({ success: true, inventory: doc });
  } catch (err) {
    next(err);
  }
}

export async function history(req, res, next) {
  try {
    const rows = await InventoryMovement.find({ ...requestScope(req) }).sort({ createdAt: -1 }).limit(500);
    res.json({ success: true, movements: rows });
  } catch (err) {
    next(err);
  }
}

export async function adjust(req, res, next) {
  try {
    const { productId } = req.params;
    const { type = 'adjustment', quantity, reason = '' } = req.body || {};

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ApiError(422, 'Quantity must be a positive number.', 'VALIDATION_ERROR');
    }

    // Strict type validation — unknown types are REJECTED, not silently
    // coerced to a default, so malformed requests can never cause an
    // unintended stock direction.
    const VALID_TYPES = ['restock', 'remove', 'adjustment', 'sale', 'return', 'correction', 'correction-down'];
    if (!VALID_TYPES.includes(type)) {
      throw new ApiError(422, `Invalid adjustment type "${type}".`, 'VALIDATION_ERROR');
    }
    const direction = type === 'remove' || type === 'sale' || type === 'correction-down' ? -1 : 1;
    const delta = direction * qty;

    const inv = await adjustStock({
      productSlug: productId,
      delta,
      type: type === 'remove' ? 'adjustment' : type,
      reason,
      createdBy: req.user.name || req.user.email,
      // Server-derived membership: the stock row must belong to the caller's
      // workspace (legacy rows included), otherwise the service answers 404.
      workspaceId: getWorkspaceId(req.user),
    });

    res.json({ success: true, inventory: inv });
  } catch (err) {
    next(err);
  }
}
