import { Router } from 'express';
import { listCatalogue } from '../controllers/catalogueController.js';

const router = Router();

/* Public read: no token, no write surface. The controller decides visibility
   and returns an ETag; Express/Node still handles the conditional GET. */
router.get('/', listCatalogue);

export default router;
