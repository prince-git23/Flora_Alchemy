import Customer from '../models/Customer.js';
import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import CustomRequest from '../models/CustomRequest.js';
import { ApiError } from '../middleware/errorMiddleware.js';
import { escapeRegExp, safeString } from '../utils/querySafety.js';
import { requestScope } from '../utils/tenancy.js';

/**
 * Phase 22.3 — the RELATIONSHIP rule for staff visibility.
 *
 * Customer profiles are global identities (a person is one person everywhere;
 * they are not workspace members), so membership cannot be read off a field.
 * Staff of workspace W may therefore see a customer only when that customer
 * is linked to W through an order, a conversation or a custom request W can
 * read. With an empty scope (single-workspace compatibility mode, or the
 * platform owner) every customer remains visible — exactly as before 22.3.
 *
 * Returns `true` when the caller may see this customer at all.
 */
async function customerVisibleInScope(req, customerId) {
  const scope = requestScope(req);
  if (Object.keys(scope).length === 0) return true;
  const [byOrder, byConversation, byRequest] = await Promise.all([
    Order.distinct('_id', { customerId, ...requestScope(req) }),
    Conversation.distinct('_id', { customerId, ...requestScope(req) }),
    CustomRequest.distinct('_id', { customerId, ...requestScope(req) }),
  ]);
  return byOrder.length > 0 || byConversation.length > 0 || byRequest.length > 0;
}

export async function listCustomers(req, res, next) {
  try {
    const q = escapeRegExp(safeString(req.query.q, 200)).toLowerCase();
    const match = q
      ? {
          $or: [
            { name: { $regex: q, $options: 'i' } },
            { email: { $regex: q, $options: 'i' } },
          ],
        }
      : {};
    // Relationship-scoped list (see customerVisibleInScope): only customers
    // this workspace has actually served are listed; the query stays a single
    // find by feeding the related ids in as a pre-computed restriction.
    const scope = requestScope(req);
    if (Object.keys(scope).length > 0) {
      const [byOrder, byConversation, byRequest] = await Promise.all([
        Order.distinct('customerId', { ...requestScope(req) }),
        Conversation.distinct('customerId', { ...requestScope(req) }),
        CustomRequest.distinct('customerId', { ...requestScope(req) }),
      ]);
      const related = [...new Set([...byOrder, ...byConversation, ...byRequest].map((id) => String(id)))];
      match._id = { $in: related };
    }
    const customers = await Customer.find({
      // `match` is already narrowed by the workspaceId relationship rule
      // above; with an empty scope it holds only the optional search text.
      ...match,
    }).sort({ createdAt: -1 }).limit(500);
    res.json({ success: true, customers });
  } catch (err) {
    next(err);
  }
}

export async function getCustomer(req, res, next) {
  try {
    const { id } = req.params;

    // Ownership rule: customers may read their own profile; handler/admin may
    // read any profile IN ITS WORKSPACE RELATIONSHIP. A non-owner never
    // learns a record exists → 404 (same status as cross-workspace).
    const isStaff = ['admin', 'handler'].includes(req.user.role);
    if (!isStaff && String(req.user.customerId || '') !== id) {
      throw new ApiError(404, 'Customer not found.', 'NOT_FOUND');
    }

    let customer;
    try {
      customer = await Customer.findOne({
        // Customer records are workspace-agnostic by design (no workspaceId
        // field): the workspace test below is a relationship test.
        _id: id,
      });
    } catch {
      customer = null;
    }
    if (!customer) {
      throw new ApiError(404, 'Customer not found.', 'NOT_FOUND');
    }
    if (isStaff && !(await customerVisibleInScope(req, customer._id))) {
      // Not linked to this workspace → behave as if it never existed.
      throw new ApiError(404, 'Customer not found.', 'NOT_FOUND');
    }
    res.json({ success: true, customer });
  } catch (err) {
    next(err);
  }
}

export async function getMyProfile(req, res, next) {
  try {
    if (req.user.role !== 'customer' || !req.user.customerId) {
      throw new ApiError(404, 'Customer profile not found.', 'NOT_FOUND');
    }
    const customer = await Customer.findOne({
      // Owner-scoped by the JWT's customerId; profiles carry no workspaceId,
      // so a workspace filter would be meaningless here.
      _id: req.user.customerId,
    });
    if (!customer) {
      throw new ApiError(404, 'Customer profile not found.', 'NOT_FOUND');
    }
    res.json({ success: true, customer });
  } catch (err) {
    next(err);
  }
}

export async function updateCustomer(req, res, next) {
  try {
    const { id } = req.params;
    const isStaff = ['admin', 'handler'].includes(req.user.role);
    if (!isStaff && String(req.user.customerId || '') !== id) {
      throw new ApiError(403, 'You can only update your own profile.', 'FORBIDDEN');
    }

    const customer = await Customer.findOne({
      // Global identity lookup (see listCustomers); the workspaceId test is
      // the relationship rule, applied below for staff writers.
      _id: id,
    });
    if (!customer) {
      throw new ApiError(404, 'Customer not found.', 'NOT_FOUND');
    }
    if (isStaff && !(await customerVisibleInScope(req, customer._id))) {
      throw new ApiError(404, 'Customer not found.', 'NOT_FOUND');
    }

    const allowed = ['name', 'phone', 'addresses', 'preferences', 'city', 'state', 'status'];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        // email changes are deliberately not allowed here (identity field)
        if (field === 'email') continue;
        customer[field] = req.body[field];
      }
    }
    // Only staff can flip Active/Inactive
    if (req.body.status !== undefined && !isStaff) delete req.body.status;

    await customer.save();
    res.json({ success: true, customer });
  } catch (err) {
    next(err);
  }
}

// ─── Own addresses (customer-only; ownership from the JWT) ───

async function ownerCustomer(req) {
  if (req.user.role !== 'customer' || !req.user.customerId) {
    throw new ApiError(403, 'Only customers manage their own addresses.', 'FORBIDDEN');
  }
  const customer = await Customer.findOne({
    // Owner-scoped by the JWT, never by workspace: address book entries hang
    // off the global customer record (no workspaceId field exists on it).
    _id: req.user.customerId,
  });
  if (!customer) {
    throw new ApiError(404, 'Customer profile not found.', 'NOT_FOUND');
  }
  return customer;
}

function normalizeAddress(body) {
  const a = body || {};
  const address = String(a.address || '').trim();
  const city = String(a.city || '').trim();
  const state = String(a.state || '').trim();
  const pincode = String(a.pincode || '').trim();
  if (address.length < 3) throw new ApiError(422, 'Please provide a street address.', 'VALIDATION_ERROR');
  if (city.length < 2) throw new ApiError(422, 'Please provide a city.', 'VALIDATION_ERROR');
  if (state.length < 2) throw new ApiError(422, 'Please provide a state.', 'VALIDATION_ERROR');
  if (!/^\d{5,6}$/.test(pincode)) {
    throw new ApiError(422, 'Please provide a valid postal code.', 'VALIDATION_ERROR');
  }
  return {
    label: String(a.label || 'Home').slice(0, 40),
    name: String(a.name || '').trim(),
    address,
    city,
    state,
    pincode,
    phone: String(a.phone || '').trim(),
    isDefault: !!a.isDefault,
  };
}

export async function getMyAddresses(req, res, next) {
  try {
    const customer = await ownerCustomer(req);
    res.json({ success: true, addresses: customer.addresses || [] });
  } catch (err) {
    next(err);
  }
}

export async function addAddress(req, res, next) {
  try {
    const customer = await ownerCustomer(req);
    const data = normalizeAddress(req.body);
    const addresses = customer.addresses || [];
    const isFirst = addresses.length === 0;
    data.isDefault = isFirst || data.isDefault;
    // Only one default address.
    if (data.isDefault) {
      addresses.forEach((a) => { a.isDefault = false; });
    }
    addresses.push(data);
    customer.addresses = addresses;
    await customer.save();
    res.status(201).json({ success: true, customer });
  } catch (err) {
    next(err);
  }
}

export async function updateAddress(req, res, next) {
  try {
    const customer = await ownerCustomer(req);
    const { addressId } = req.params;
    const addresses = customer.addresses || [];
    const idx = addresses.findIndex((a) => String(a._id) === String(addressId));
    if (idx === -1) {
      throw new ApiError(404, 'Address not found.', 'NOT_FOUND');
    }
    const data = normalizeAddress({ ...addresses[idx].toObject(), ...req.body });
    if (data.isDefault) {
      addresses.forEach((a) => { a.isDefault = false; });
    }
    addresses[idx] = { ...addresses[idx].toObject(), ...data };
    customer.addresses = addresses;
    await customer.save();
    res.json({ success: true, customer });
  } catch (err) {
    next(err);
  }
}

export async function deleteAddress(req, res, next) {
  try {
    const customer = await ownerCustomer(req);
    const { addressId } = req.params;
    const addresses = (customer.addresses || []).filter((a) => String(a._id) !== String(addressId));
    if (addresses.length === (customer.addresses || []).length) {
      throw new ApiError(404, 'Address not found.', 'NOT_FOUND');
    }
    // If the default was removed, promote the first remaining address.
    if (addresses.length > 0 && !addresses.some((a) => a.isDefault)) {
      addresses[0].isDefault = true;
    }
    customer.addresses = addresses;
    await customer.save();
    res.json({ success: true, customer });
  } catch (err) {
    next(err);
  }
}
