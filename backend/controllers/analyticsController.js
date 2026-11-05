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
    // No `days` keeps the historical all-time aggregate; a supplied value is
    // clamped like /sales. NaN falls back to 30 rather than reaching Mongo.
    const days = req.query.days === undefined
      ? null
      : Math.min(Math.max(Number(req.query.days) || 30, 1), 3650);
    const data = await computePerformance(req, days);
    res.json({ success: true, analytics: data });
  } catch (err) {
    next(err);
  }
}

// Re-exported guard for route wiring clarity
export { ApiError };
