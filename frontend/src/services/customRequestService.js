import api from './apiClient.js';

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
 * (Phase 23 policy: a handler may review/quote/accept, only an administrator
 * may decline) and answers 403 ACTION_NOT_PERMITTED otherwise — `unwrap`
 * carries that code, so the Action Center can show the real rule.
 */
export async function updateCustomRequestStatus(id, status, adminNotes) {
  const res = await unwrap(
    await api.patch(`/custom-requests/${id}/status`, { status, adminNotes }, { scope: 'admin' })
  );
  return res.request;
}
