import { Router } from 'express';
import { getSettings, updateSettings } from '../controllers/settingsController.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';
import { requireWorkspaceOrOwner } from '../middleware/workspaceMiddleware.js';

const router = Router();

// Public: storefront reads currency/shipping/availability config (the shared
// singleton; the storefront has no workspace context in Phase 22.3). A staff
// token additionally receives ITS workspace's document from the controller.
router.get('/', getSettings);

// Staff writes — ADMIN level. Global store configuration (currency, order
// availability, shipping/commerce policy) is administrator territory: the
// portal UI already restricts settings to /admin/* (AdminRoute), and handlers
// (the /staff/* portal) have no settings surface. Previously adminOrHandler
// let any handler flip store-wide settings.
//
// Phase 22.3 — the gate splits WHO is patched:
//   owner          → platform settings (§19 Platform Settings) → singleton;
//   workspace admin → its own workspace's document (clone-on-first-write);
//   compat admin   → singleton (no workspace exists yet).
router.patch('/', protect, requireRole('admin'), requireWorkspaceOrOwner, updateSettings);

export default router;
