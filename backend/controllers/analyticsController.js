import { computeOverview, computeSales, computePerformance } from '../services/analyticsService.js';
import { ApiError } from '../middleware/errorMiddleware.js';

export async function overview(req, res, next) {
  try {
    const data = await computeOverview(req);
    res.json({ success: true, analytics: data });
  } catch (err) {
    next(err);
  }
}

export async function sales(req, res, next) {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const data = await computeSales(req, days);
    res.json({ success: true, analytics: data });
  } catch (err) {
    next(err);
  }
}

export async function performance(req, res, next) {
  try {
    const data = await computePerformance(req);
    res.json({ success: true, analytics: data });
  } catch (err) {
    next(err);
  }
}

// Re-exported guard for route wiring clarity
export { ApiError };
