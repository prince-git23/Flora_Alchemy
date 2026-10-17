import crypto from 'node:crypto';

/**
 * Central error helpers. Every controller error is normalized to:
 *   { success: false, message, code, status }
 * Stack traces are never sent to clients.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} message client-safe sentence
   * @param {string} code   stable machine code (`STORAGE_NOT_WRITABLE`, …)
   * @param {Error|string} [cause] the underlying failure. RETAINED, not
   *   swallowed: an earlier revision passed a fourth argument that this
   *   constructor ignored, so the sharp/fs reason vanished and a diagnostic
   *   report was strictly less useful than the exception already in hand.
   */
  constructor(status, message, code = 'ERROR', cause = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * A short, non-secret id that ties a client-visible failure to a server log
 * line. Before this, a user could report only "An unexpected server error
 * occurred…" — a sentence identical for every server fault, which is exactly
 * why a production upload failure could not be traced from the UI.
 */
function newErrorId() {
  return crypto.randomBytes(4).toString('hex');
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    code: 'NOT_FOUND',
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    // A typed 5xx (a storage condition, an upstream provider) is still a
    // server-side fault, so it gets the same correlate-with-the-log id as an
    // unhandled error. 4xx stays clean: the client already knows what to do.
    if (err.status >= 500) {
      const errorId = newErrorId();
      console.error(`[api-error] id=${errorId} code=${err.code} status=${err.status}`, err.message);
      if (err.cause) console.error(`[api-error] id=${errorId} cause=`, err.cause);
      return res.status(err.status).json({
        success: false,
        message: err.message,
        code: err.code,
        errorId,
      });
    }
    return res.status(err.status).json({
      success: false,
      message: err.message,
      code: err.code,
    });
  }

  // Mongoose validation
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors)
      .map((e) => e.message)
      .join('; ');
    return res.status(422).json({ success: false, message, code: 'VALIDATION_ERROR' });
  }

  // Duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      message: `A record with this ${field} already exists.`,
      code: 'DUPLICATE',
    });
  }

  if (err.name === 'CastError') {
    return res.status(404).json({
      success: false,
      message: 'Record not found.',
      code: 'NOT_FOUND',
    });
  }

  // Malformed JSON bodies (express.json throws SyntaxError with status 400).
  // Surface an honest 4xx — Razorpay webhooks and buggy clients must never
  // get a 500 for a body-parsing failure.
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400 && 'body' in err)) {
    return res.status(400).json({
      success: false,
      message: 'Malformed JSON in request body.',
      code: 'MALFORMED_JSON',
    });
  }

  // Multer upload errors — surface honest 4xx instead of a raw 500.
  if (err.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Image is larger than the 5 MB limit.'
        : `Upload rejected: ${err.code}`;
    return res.status(status).json({ success: false, message, code: 'UPLOAD_ERROR' });
  }

  const errorId = newErrorId();
  console.error(`[api-error] id=${errorId}`, err);
  if (err && err.cause) console.error(`[api-error] id=${errorId} cause=`, err.cause);
  return res.status(500).json({
    success: false,
    message: 'An unexpected server error occurred. Please try again.',
    code: 'INTERNAL_ERROR',
    // Same id as the log line above: support can go from a screenshot to the
    // exact stack in one search. It carries no information about the fault.
    errorId,
  });
}
