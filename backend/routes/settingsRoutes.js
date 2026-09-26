import { Router } from 'express';
import { getSettings, updateSettings } from '../controllers/settingsController.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';

const router = Router();

// Public: storefront reads currency/shipping/availability config.
router.get('/', getSettings);

// Staff writes — ADMIN level. Global store configuration (currency, order
// availability, shipping/commerce policy) is administrator territory: the
// portal UI already restricts settings to /admin/* (AdminRoute), and handlers
// (the /staff/* portal) have no settings surface. Previously adminOrHandler
// let any handler flip store-wide settings.
router.patch('/', protect, requireRole('admin'), updateSettings);

export default router;
