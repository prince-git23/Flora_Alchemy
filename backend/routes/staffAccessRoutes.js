import { Router } from 'express';
import {
  getAccessCatalogue,
  getStaffAccess,
  updateStaffAccess,
} from '../controllers/staffAccessController.js';
import { protect, requireRole } from '../middleware/authMiddleware.js';
import { requireWorkspaceOrOwner } from '../middleware/workspaceMiddleware.js';

/**
 * GRANULAR STAFF ACCESS routes (administrator surface).
 *
 * /api/admin/access/*
 *
 * `requireRole('admin')` is the authority: handlers and customers are refused
 * here no matter what the UI renders. `requireWorkspaceOrOwner` then applies
 * the workspace scope the controller spreads into every query — a workspace
 * admin reaches only its own staff; the owner keeps the platform view (owner
 * OWNS the administrator cohort, which this surface refuses to edit).
 *
 * Mounted BEFORE /api/admin/staff so the literal `access` prefix can never be
 * swallowed by a `/:id` route in the neighbouring router.
 */
const router = Router();

router.use(protect, requireRole('admin'), requireWorkspaceOrOwner);

router.get('/catalogue', getAccessCatalogue);
router.get('/staff/:id', getStaffAccess);
router.patch('/staff/:id', updateStaffAccess);

export default router;
