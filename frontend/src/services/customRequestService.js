import api, { API_BASE_URL, getToken } from './apiClient.js';

/**
 * apiClient returns a { ok, status, message, data } envelope instead of
 * throwing. Every consumer of this service (CustomRequestPage submit,
 * AccountPage overview, Admin custom-request pages) expects a throwing
 * contract, so unwrap here and normalize errors.
 */
async function unwrap(result) {
  if (!result.ok) {
    const err = new Error(result.message || 'Request failed. Please try again.');
    err.status = result.status;
    err.code = result.code;
    throw err;
  }
  return result.data;
}

// Customer: submit a bespoke request (identity from the customer JWT).
export async function createCustomRequest(data) {
  const res = await unwrap(await api.post('/custom-requests', data, { scope: 'customer' }));
  return res.request;
}

// Customer: list their own requests.
export async function getMyCustomRequests() {
  const res = await unwrap(await api.get('/custom-requests/mine', { scope: 'customer' }));
  return res.requests;
}

/**
 * One request with its proposal + resulting order.
 * `scope` decides the identity: customers read their OWN request (the server
 * derives ownership from the JWT); staff read a workspace-scoped request.
 */
export async function getCustomRequest(id, scope = 'customer') {
  const res = await unwrap(await api.get(`/custom-requests/${id}`, { scope }));
  return { request: res.request, proposal: res.proposal || null, order: res.order || null };
}

// Staff: list all requests (adminOrHandler on the backend).
export async function getAllCustomRequests(status) {
  const qs = status && status !== 'All' ? `?status=${encodeURIComponent(status)}` : '';
  const res = await unwrap(await api.get(`/custom-requests${qs}`, { scope: 'admin' }));
  return res.requests;
}

/**
 * Staff: update status / admin notes (adminOrHandler on the backend).
 *
 * The server also decides whether THIS identity may perform THIS transition
 * (Phase 23 policy: a handler may review/quote/accept and fulfill, only an
 * administrator may decline) and answers 403 ACTION_NOT_PERMITTED otherwise —
 * `unwrap` carries that code, so the Action Center can show the real rule.
 * A transition the persisted state does not allow answers 422
 * INVALID_TRANSITION; rejecting a request REQUIRES a rejectionReason.
 */
export async function updateCustomRequestStatus(id, status, adminNotes, rejectionReason) {
  const body = { status };
  if (adminNotes !== undefined) body.adminNotes = adminNotes;
  if (rejectionReason !== undefined) body.rejectionReason = rejectionReason;
  const res = await unwrap(await api.patch(`/custom-requests/${id}/status`, body, { scope: 'admin' }));
  return res.request;
}

/**
 * Staff: create or replace the DRAFT proposal. Items are admin-authored
 * dynamic line items; the SERVER calculates every lineTotal/subtotal/total
 * (client totals are never trusted).
 */
export async function saveProposal(id, items) {
  const res = await unwrap(
    await api.post(`/custom-requests/${id}/proposal`, { items }, { scope: 'admin' })
  );
  return { request: res.request, proposal: res.proposal };
}

// Staff: send the proposal to the customer (locks totals; request → quoted).
export async function sendProposal(id) {
  const res = await unwrap(await api.post(`/custom-requests/${id}/proposal/send`, {}, { scope: 'admin' }));
  return { request: res.request, proposal: res.proposal };
}

// Staff: withdraw a proposal the customer has not answered (request → accepted).
export async function withdrawProposal(id) {
  const res = await unwrap(await api.post(`/custom-requests/${id}/proposal/withdraw`, {}, { scope: 'admin' }));
  return { request: res.request, proposal: res.proposal };
}

/**
 * Customer: accept the proposal. The server creates the REAL order from the
 * STORED proposal (the request body carries nothing) and returns it so the
 * customer can proceed to the existing payment flow.
 */
export async function acceptProposal(id) {
  const res = await unwrap(await api.post(`/custom-requests/${id}/proposal/accept`, {}, { scope: 'customer' }));
  return { request: res.request, proposal: res.proposal, order: res.order };
}

// Customer: decline the proposal (optional reason, kept customer-safe).
export async function declineProposal(id, reason) {
  const res = await unwrap(
    await api.post(`/custom-requests/${id}/proposal/decline`, { reason: reason || '' }, { scope: 'customer' })
  );
  return { request: res.request, proposal: res.proposal };
}

// ─── Reference image upload ──────────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // matches the backend limit

/**
 * Upload an OPTIONAL reference image for a custom request.
 *
 * Reuses the application's validated upload pipeline
 * (POST /api/uploads/custom-request-image → the same MIME whitelist, size cap,
 * ImageKit storage or local persistence as every other image). The browser
 * never sees the ImageKit private key. Resolves with the hosted URL that is
 * stored on the request as `imageUrl`.
 */
export function uploadCustomRequestImage(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('Choose an image to upload.'));
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      reject(new Error('Unsupported format. Use JPEG, PNG, WebP, GIF or AVIF.'));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error('Image is too large. Maximum is 5 MB.'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}/uploads/custom-request-image`);
    xhr.setRequestHeader('Authorization', `Bearer ${getToken('customer') || ''}`);
    if (typeof onProgress === 'function') {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
    }
    xhr.addEventListener('load', () => {
      try {
        const json = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && json.success && json.url) {
          resolve(json.url);
        } else {
          const err = new Error(json.message || `Upload failed (${xhr.status}).`);
          err.status = xhr.status;
          reject(err);
        }
      } catch {
        reject(new Error('Upload failed — unexpected server response.'));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload. Please try again.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
    const fd = new FormData();
    fd.append('image', file);
    xhr.send(fd);
  });
}
