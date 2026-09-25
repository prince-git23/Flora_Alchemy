/*
 * Flora Alchemy — responsive audit probe (Phase 20.6.5).
 *
 * Injected as the FIRST child of <head> by serve.mjs, so it runs before the
 * inline theme script and before any module script. Responsibilities:
 *
 *   1. Seed localStorage (staff session, admin token, theme) for the run.
 *   2. Intercept window.fetch: every request that does not target our own
 *      origin (i.e. the production VITE_API_URL) is answered from local
 *      fixtures — production is never touched.
 *   3. After boot, perform the interactions named in ?actions=.
 *   4. Measure horizontal overflow, clipped content, and (on phone widths)
 *      undersized touch targets at ~3.2s and ~7s.
 *   5. Publish the result as base64 JSON in documentElement[data-audit].
 *
 * Classic script — no modules, no imports. Keep it dependency-free.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var role = params.get('role') === 'handler' ? 'handler' : 'admin';
  var dark = params.get('dark') === '1';
  var seed = params.get('seed') !== '0';
  var actions = (params.get('actions') || '').split(',').map(function (s) {
    return s.trim();
  }).filter(Boolean);

  var HOUR = 3600000;
  var now = Date.now();
  function iso(ms) { return new Date(ms).toISOString(); }
  function daysAgo(d) { return iso(now - d * 24 * HOUR); }
  function hoursAhead(h) { return iso(now + h * HOUR); }

  /* ────────────────────────────── errors ─────────────────────────────── */

  var errors = [];
  window.addEventListener('error', function (e) {
    errors.push(String((e && e.message) || 'error').slice(0, 300));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    errors.push('unhandledrejection: ' + String((r && (r.message || r)) || r).slice(0, 300));
  });

  /* ────────────────────── theme + session seeding ────────────────────── */

  try {
    localStorage.setItem('flora_alchemy_theme', dark ? 'dark' : 'light');
  } catch (e) { /* storage unavailable */ }

  try {
    if (seed) {
      var session =
        role === 'handler'
          ? {
              token: 'audit-token',
              id: 'u-handler-07',
              email: 'meera.nambiar@floraalchemy.in',
              name: 'Meera Nambiar',
              role: 'handler',
              isOwner: false,
              staffId: 'HND-0007',
              roleLabel: 'Handler',
              department: 'Atelier Floor',
              loggedInAt: iso(now),
            }
          : {
              token: 'audit-token',
              id: 'u-owner-01',
              email: 'aditya.rao@floraalchemy.in',
              name: 'Aditya Rao',
              role: 'admin',
              isOwner: true,
              staffId: 'ADM-0001',
              roleLabel: 'Owner',
              department: 'Atelier Direction',
              loggedInAt: iso(now),
            };
      localStorage.setItem('flora_alchemy_admin_session', JSON.stringify(session));
      localStorage.setItem('flora_alchemy_admin_token', 'audit-token');
    } else {
      localStorage.removeItem('flora_alchemy_admin_session');
      localStorage.removeItem('flora_alchemy_admin_token');
    }
    // Never carry a customer identity into a staff run.
    localStorage.removeItem('flora_alchemy_customer_token');
    localStorage.removeItem('flora_alchemy_customer_session');
    localStorage.removeItem('flora_alchemy_account');
  } catch (e) { /* storage unavailable */ }

  /* ────────────────────────────── fixtures ───────────────────────────── */

  function product(slug, name, price, category) {
    return {
      id: slug,
      slug: slug,
      name: name,
      price: price,
      mrp: Math.round(price * 1.15),
      categoryLabel: category,
      image: '',
      images: [],
      stock: 14,
      visibility: 'Visible',
      isPublished: true,
      description: 'Handcrafted botanical keepsake, pressed and preserved in the Flora Alchemy atelier.',
    };
  }

  var products = [
    product('rose-keepsake-box', 'Rose Keepsake Box', 1499, 'Keepsakes'),
    product('lavender-glass-vial', 'Lavender Glass Vial', 899, 'Preserves'),
    product('pressed-flower-frame', 'Pressed Flower Frame', 1199, 'Frames'),
    product('botanical-candle', 'Botanical Candle', 749, 'Candles'),
    product('wildflower-wreath', 'Wildflower Wreath', 1899, 'Wreaths'),
    product('amber-perfume-roller', 'Amber Perfume Roller', 649, 'Fragrance'),
  ];

  function order(n, status, ageDays, name, email, total) {
    var created = now - ageDays * 24 * HOUR;
    return {
      orderId: 'FA-' + (1200 + n),
      status: status,
      orderStatus: status,
      customerName: name,
      customerEmail: email,
      items: [
        {
          productSlug: 'rose-keepsake-box',
          name: 'Rose Keepsake Box',
          price: 1499,
          quantity: 1,
          image: '',
          palette: 'ivory',
          ribbon: 'sage',
        },
      ],
      subtotal: total,
      shipping: 99,
      tax: 0,
      discount: 0,
      total: total + 99,
      paymentStatus: 'Paid',
      paymentMethod: 'razorpay',
      shippingAddress: {
        fullName: name,
        line1: '12 MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        phone: '+91 98765 43210',
      },
      statusHistory: [
        { status: 'new', note: 'Order placed', changedBy: 'customer', timestamp: iso(created) },
        { status: status, note: 'Atelier updated the order', changedBy: 'handler', timestamp: iso(created + 5 * HOUR) },
      ],
      createdAt: iso(created),
      updatedAt: iso(created + 5 * HOUR),
    };
  }

  var orders = [
    order(1, 'new', 1, 'Ishaan Verma', 'ishaan@example.com', 1499),
    order(2, 'confirmed', 2, 'Priya Menon', 'priya@example.com', 899),
    order(3, 'in_production', 3, 'Rahul Sharma', 'rahul@example.com', 1899),
    order(4, 'in_production', 4, 'Ananya Iyer', 'ananya@example.com', 1199),
    order(5, 'quality_check', 5, 'Kabir Singh', 'kabir@example.com', 749),
    order(6, 'ready_to_dispatch', 6, 'Sara Khan', 'sara@example.com', 649),
    order(7, 'shipped', 8, 'Vikram Patel', 'vikram@example.com', 1499),
    order(8, 'delivered', 14, 'Neha Gupta', 'neha@example.com', 899),
  ];

  var customers = [
    { id: 'c-1', name: 'Ishaan Verma', email: 'ishaan@example.com', phone: '+91 90000 11111', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', orders: 4, totalSpent: 6896, createdAt: daysAgo(120) },
    { id: 'c-2', name: 'Priya Menon', email: 'priya@example.com', phone: '+91 90000 22222', city: 'Kochi', state: 'Kerala', pincode: '682016', orders: 2, totalSpent: 2198, createdAt: daysAgo(64) },
    { id: 'c-3', name: 'Rahul Sharma', email: 'rahul@example.com', phone: '+91 90000 33333', city: 'Jaipur', state: 'Rajasthan', pincode: '302001', orders: 7, totalSpent: 11493, createdAt: daysAgo(300) },
    { id: 'c-4', name: 'Ananya Iyer', email: 'ananya@example.com', phone: '+91 90000 44444', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', orders: 1, totalSpent: 1298, createdAt: daysAgo(9) },
    { id: 'c-5', name: 'Kabir Singh', email: 'kabir@example.com', phone: '+91 90000 55555', city: 'Pune', state: 'Maharashtra', pincode: '411001', orders: 3, totalSpent: 4497, createdAt: daysAgo(45) },
  ];

  function inv(productId, name, stock, reorder, status) {
    return {
      id: 'inv-' + productId,
      productId: productId,
      productSlug: productId,
      productName: name,
      currentStock: stock,
      reorderLevel: reorder,
      unit: 'pcs',
      status: status,
      updatedAt: daysAgo(2),
    };
  }

  var inventory = [
    inv('rose-keepsake-box', 'Rose Keepsake Box', 4, 10, 'Low Stock'),
    inv('lavender-glass-vial', 'Lavender Glass Vial', 2, 8, 'Critical'),
    inv('pressed-flower-frame', 'Pressed Flower Frame', 23, 10, 'Healthy'),
    inv('botanical-candle', 'Botanical Candle', 31, 12, 'Healthy'),
    inv('wildflower-wreath', 'Wildflower Wreath', 6, 6, 'Low Stock'),
    inv('amber-perfume-roller', 'Amber Perfume Roller', 42, 15, 'Healthy'),
  ];

  /* ── staff roster (staffController row shapes) ── */

  function staffRow(o) {
    return Object.assign(
      {
        kind: 'user',
        phone: '+91 98765 43210',
        department: 'Atelier Floor',
        isFixture: false,
        isSelf: false,
        invitedBy: 'u-owner-01',
        invitedByName: 'Aditya Rao',
        createdAt: daysAgo(90),
        joinedLabel: '3 months ago',
        lastActiveAt: iso(now - 2 * HOUR),
        lastActiveLabel: '2 hours ago',
        suspension: null,
        actions: { canEditProfile: true },
      },
      o
    );
  }

  var ownerRow = staffRow({
    id: 'u-owner-01',
    name: 'Aditya Rao',
    initials: 'AR',
    email: 'aditya.rao@floraalchemy.in',
    role: 'admin',
    roleLabel: 'Owner',
    roleBadge: 'OWNER',
    staffId: 'ADM-0001',
    department: 'Atelier Direction',
    status: 'ACTIVE',
    isOwner: true,
    isSelf: true,
    createdAt: daysAgo(540),
    joinedLabel: '1.5 years ago',
    actions: { canEditProfile: true, note: 'This is your own account.' },
  });

  var adminRow = staffRow({
    id: 'u-admin-02',
    name: 'Kavya Reddy',
    initials: 'KR',
    email: 'kavya.reddy@floraalchemy.in',
    role: 'admin',
    roleLabel: 'Administrator',
    roleBadge: 'ADMIN',
    staffId: 'ADM-0002',
    department: 'Operations',
    actions: { canEditProfile: true, canSuspend: true },
  });

  var handler1 = staffRow({
    id: 'u-handler-07',
    name: 'Meera Nambiar',
    initials: 'MN',
    email: 'meera.nambiar@floraalchemy.in',
    role: 'handler',
    roleLabel: 'Handler',
    roleBadge: 'HANDLER',
    staffId: 'HND-0007',
    department: 'Atelier Floor',
    createdAt: daysAgo(45),
    joinedLabel: '45 days ago',
    actions: { canEditProfile: true, canSuspend: true },
  });

  var handler2 = staffRow({
    id: 'u-handler-11',
    name: 'Dev Kapoor',
    initials: 'DK',
    email: 'dev.kapoor@floraalchemy.in',
    role: 'handler',
    roleLabel: 'Handler',
    roleBadge: 'HANDLER',
    staffId: 'HND-0011',
    department: 'Packing Bay',
    status: 'SUSPENDED',
    createdAt: daysAgo(150),
    joinedLabel: '5 months ago',
    lastActiveAt: iso(now - 9 * 24 * HOUR),
    lastActiveLabel: '9 days ago',
    suspension: {
      reason: 'Repeated bench no-shows',
      note: 'Second incident this quarter — review with the atelier lead.',
      at: iso(now - 9 * 24 * HOUR),
    },
    actions: { canEditProfile: true, canReactivate: true },
  });

  var handler3 = staffRow({
    id: 'u-handler-14',
    name: 'Tara Bose',
    initials: 'TB',
    email: 'tara.bose@floraalchemy.in',
    role: 'handler',
    roleLabel: 'Handler',
    roleBadge: 'HANDLER',
    staffId: 'HND-0014',
    department: 'Resin Studio',
    createdAt: daysAgo(12),
    joinedLabel: '12 days ago',
    actions: { canEditProfile: true, canSuspend: true },
  });

  var inviteRow = staffRow({
    id: 'INV-00A1B2',
    kind: 'invitation',
    name: 'Rohan Das',
    initials: 'RD',
    email: 'rohan.das@example.com',
    role: 'handler',
    roleLabel: 'Handler',
    roleBadge: 'INVITED',
    staffId: 'INV-00A1B2',
    department: 'Packing Bay',
    status: 'INVITED',
    createdAt: iso(now - 30 * HOUR),
    joinedLabel: 'Invited yesterday',
    lastActiveAt: null,
    lastActiveLabel: 'Never',
    resendCount: 1,
    expiresAt: hoursAhead(42),
    canResend: true,
    canRevoke: true,
    actions: { canResend: true, canRevoke: true },
  });

  var staffRows = [ownerRow, adminRow, handler1, handler2, handler3, inviteRow];

  var staffCounts = {
    all: staffRows.length,
    handlers: 3,
    administrators: 2,
    active: 4,
    invited: 1,
    suspended: 1,
    expired: 0,
    revoked: 0,
  };

  var activityEvents = [
    { id: 'ev-1', type: 'ACCOUNT_CREATED', message: 'Account activated from the invitation link.', at: daysAgo(45), atLabel: '45d ago' },
    { id: 'ev-2', type: 'LOGIN', message: 'Signed in from Bengaluru, IN.', at: daysAgo(3), atLabel: '3d ago' },
    { id: 'ev-3', type: 'PROFILE_UPDATED', message: 'Department changed to Atelier Floor.', at: daysAgo(20), atLabel: '20d ago' },
    { id: 'ev-4', type: 'INVITATION_CREATED', message: 'Invitation issued to rohan.das@example.com.', at: iso(now - 30 * HOUR), atLabel: '1d ago' },
  ];

  var staffInvitations = [
    {
      id: 'INV-00A1B2',
      kind: 'invitation',
      invitationId: 'INV-00A1B2',
      recipientName: 'Rohan Das',
      recipientEmail: 'rohan.das@example.com',
      name: 'Rohan Das',
      email: 'rohan.das@example.com',
      role: 'handler',
      roleLabel: 'Handler',
      department: 'Packing Bay',
      phone: '',
      status: 'INVITED',
      invitedBy: 'u-owner-01',
      invitedByName: 'Aditya Rao',
      createdAt: iso(now - 30 * HOUR),
      lastSentAt: iso(now - 4 * HOUR),
      expiresAt: hoursAhead(42),
      resendCount: 1,
      canResend: true,
      canRevoke: true,
      actions: { canResend: true, canRevoke: true },
    },
    {
      id: 'INV-00C3D4',
      kind: 'invitation',
      invitationId: 'INV-00C3D4',
      recipientName: 'Sneha Rao',
      recipientEmail: 'sneha.rao@example.com',
      name: 'Sneha Rao',
      email: 'sneha.rao@example.com',
      role: 'admin',
      roleLabel: 'Administrator',
      department: 'Operations',
      phone: '',
      status: 'INVITED',
      invitedBy: 'u-owner-01',
      invitedByName: 'Aditya Rao',
      createdAt: daysAgo(2),
      lastSentAt: daysAgo(2),
      expiresAt: hoursAhead(6),
      resendCount: 0,
      canResend: true,
      canRevoke: true,
      actions: { canResend: true, canRevoke: true },
    },
    {
      id: 'INV-00E5F6',
      kind: 'invitation',
      invitationId: 'INV-00E5F6',
      recipientName: 'Aman Joshi',
      recipientEmail: 'aman.joshi@example.com',
      name: 'Aman Joshi',
      email: 'aman.joshi@example.com',
      role: 'handler',
      roleLabel: 'Handler',
      department: 'Resin Studio',
      phone: '',
      status: 'EXPIRED',
      invitedBy: 'u-admin-02',
      invitedByName: 'Kavya Reddy',
      createdAt: daysAgo(6),
      lastSentAt: daysAgo(6),
      expiresAt: daysAgo(3),
      resendCount: 0,
      canResend: true,
      canRevoke: false,
      actions: { canResend: true },
    },
  ];

  var invitationCounts = {
    all: staffInvitations.length,
    pending: 2,
    accepted: 0,
    expired: 1,
    revoked: 0,
  };

  var operators = [
    { id: 'u-owner-01', name: 'Aditya Rao', initials: 'AR', email: 'aditya.rao@floraalchemy.in', role: 'ADMINISTRATOR', status: 'ACTIVE', isFixture: false, isOwner: true, createdAt: daysAgo(540), lastActiveLabel: 'just now' },
    { id: 'u-admin-02', name: 'Kavya Reddy', initials: 'KR', email: 'kavya.reddy@floraalchemy.in', role: 'ADMINISTRATOR', status: 'ACTIVE', isFixture: false, createdAt: daysAgo(300), lastActiveLabel: '1 hour ago' },
    { id: 'u-handler-07', name: 'Meera Nambiar', initials: 'MN', email: 'meera.nambiar@floraalchemy.in', role: 'HANDLER', status: 'ACTIVE', isFixture: false, createdAt: daysAgo(45), lastActiveLabel: '2 hours ago' },
    { id: 'u-handler-11', name: 'Dev Kapoor', initials: 'DK', email: 'dev.kapoor@floraalchemy.in', role: 'HANDLER', status: 'SUSPENDED', isFixture: false, createdAt: daysAgo(150), lastActiveLabel: '9 days ago' },
    { id: 'u-handler-14', name: 'Tara Bose', initials: 'TB', email: 'tara.bose@floraalchemy.in', role: 'HANDLER', status: 'ACTIVE', isFixture: false, createdAt: daysAgo(12), lastActiveLabel: '3 days ago' },
  ];

  var invitationView = {
    role: 'handler',
    roleLabel: 'Handler',
    recipientEmail: 'rohan.das@example.com',
    recipientName: 'Rohan Das',
    department: 'Packing Bay',
    applicantName: null,
    applicationId: 'APP-2026-0142',
    invitationId: 'INV-00A1B2',
    invitedByName: 'Aditya Rao',
    createdAt: iso(now - 30 * HOUR),
    expiresAt: hoursAhead(42),
    status: 'INVITED',
  };

  var settings = {
    storeName: 'Flora Alchemy',
    storeTagline: 'Handcrafted botanical keepsakes',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    storeAvailability: 'open',
    acceptNewOrders: true,
    contactEmail: 'hello@floraalchemy.in',
    contactPhone: '+91 80 4123 5678',
    updatedAt: daysAgo(7),
    shippingConfiguration: { panIndia: true, freeShippingThreshold: 1999, standardRate: 99, expressRate: 149 },
    commerceConfiguration: { orderPrefix: 'FA', taxEnabled: false },
  };

  var notifications = [
    { id: 'n-1', title: 'Low stock: Lavender Glass Vial', message: 'Current stock 2, reorder level 8.', read: false, createdAt: iso(now - 3 * HOUR) },
    { id: 'n-2', title: 'New order FA-1201', message: 'Ishaan Verma placed a new order.', read: true, createdAt: iso(now - 26 * HOUR) },
  ];

  function staffMemberFor(id) {
    var found = null;
    staffRows.forEach(function (r) {
      if (r.id === id || r.staffId === id) found = r;
    });
    return found || handler1;
  }

  function fixtureFor(pathname) {
    // pathname is the API path AFTER the /api prefix, e.g. '/admin/staff'.
    var p = String(pathname || '/');

    if (p === '/products') return { success: true, products: products };
    if (p === '/collections') return { success: true, collections: [] };
    if (p === '/settings') return { success: true, settings: settings };
    if (p === '/orders') return { success: true, orders: orders };
    if (p === '/orders/mine') return { success: true, orders: orders.slice(0, 3) };
    if (p === '/customers') return { success: true, customers: customers };
    if (p === '/inventory') return { success: true, inventory: inventory };
    if (p === '/inventory/history') return { success: true, movements: [] };
    if (p === '/analytics/overview') return { success: true, analytics: null };
    if (p === '/auth/me') return { success: true, customer: null };
    if (p === '/auth/login') {
      return {
        success: true,
        token: 'audit-token',
        user: {
          id: 'u-owner-01',
          email: 'aditya.rao@floraalchemy.in',
          name: 'Aditya Rao',
          role: 'admin',
          isOwner: true,
          staffId: 'ADM-0001',
          roleLabel: 'Owner',
          department: 'Atelier Direction',
        },
      };
    }
    if (p === '/admin/users') return { success: true, operators: operators };
    if (p === '/admin/staff') return { success: true, staff: staffRows, counts: staffCounts };
    if (/^\/admin\/staff\/[^/]+\/activity$/.test(p)) return { success: true, events: activityEvents };
    if (/^\/admin\/staff\/[^/]+$/.test(p)) {
      var id = decodeURIComponent(p.split('/')[3]);
      return { success: true, member: staffMemberFor(id) };
    }
    if (p === '/admin/invitations') return { success: true, invitations: staffInvitations, counts: invitationCounts };
    if (/^\/invitations\/[^/]+$/.test(p)) return { success: true, invitation: invitationView };
    if (/^\/invitations\/[^/]+\/activate$/.test(p)) {
      return { success: true, account: { id: 'u-handler-07', email: 'rohan.das@example.com', name: 'Rohan Das', role: 'handler' } };
    }
    if (p === '/notifications') return { success: true, notifications: notifications, unreadCount: 1 };
    if (p === '/notifications/unread-count') return { success: true, unreadCount: 1 };
    if (p === '/custom-requests') return { success: true, requests: [] };
    if (p === '/conversations') return { success: true, conversations: [] };
    if (p === '/wishlist') return { success: true, items: [] };

    // Generic fallback — still a valid envelope, never a network failure.
    return { success: true };
  }

  /* ─────────────────────── fetch interception ────────────────────────── */

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  var apiHits = [];

  function apiPathFor(url) {
    try {
      var u = new URL(url, location.href);
      var path = u.pathname;
      var idx = path.indexOf('/api');
      if (idx >= 0) path = path.slice(idx + 4);
      if (path.charAt(0) !== '/') path = '/' + path;
      return path;
    } catch (e) {
      return url;
    }
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url;
    if (!url || url.indexOf(location.origin) === 0) {
      return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'));
    }
    var path = apiPathFor(url);
    apiHits.push((init && init.method ? init.method : 'GET') + ' ' + path);
    var body = fixtureFor(path);
    var status = 200;
    // 401-style responses for anything we deliberately do not mock as ok?
    // No — every endpoint answers 200; the probe only cares about layout.
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  };

  /* ───────────────────── interaction helpers ─────────────────────────── */

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var p = el.parentElement;
    while (p) {
      var cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      p = p.parentElement;
    }
    return true;
  }

  function findVisible(selector, text) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (text) {
        var t = (el.textContent || '').replace(/\s+/g, ' ');
        if (t.indexOf(text) === -1) continue;
      }
      if (visible(el)) return el;
    }
    return null;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function waitFor(fn, timeout, interval) {
    var deadline = Date.now() + timeout;
    return new Promise(function (resolve) {
      (function poll() {
        var hit = fn();
        if (hit) return resolve(hit);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(poll, interval || 150);
      })();
    });
  }

  var actionLog = [];

  async function runActions() {
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      try {
        if (a === 'menu') {
          var menuBtn = await waitFor(function () {
            return findVisible('button[aria-label="Open navigation menu"]');
          }, 5000);
          if (menuBtn) { menuBtn.click(); actionLog.push('menu:clicked'); }
          else actionLog.push('menu:missing');
        } else if (a === 'dossier') {
          var row = await waitFor(function () {
            return findVisible('button', 'Meera Nambiar') || findVisible('tr', 'Meera Nambiar');
          }, 6000);
          if (row) { row.click(); actionLog.push('dossier:clicked:' + row.tagName); }
          else actionLog.push('dossier:missing');
        } else if (a === 'suspend') {
          var susBtn = await waitFor(function () {
            return findVisible('button', 'Suspend Staff Member');
          }, 5000);
          if (susBtn) { susBtn.click(); actionLog.push('suspend:clicked'); }
          else actionLog.push('suspend:missing');
        } else if (a === 'drawer') {
          var drawerBtn = await waitFor(function () {
            return findVisible('button', 'Add Handler');
          }, 5000);
          if (drawerBtn) { drawerBtn.click(); actionLog.push('drawer:clicked'); }
          else actionLog.push('drawer:missing');
        } else if (a === 'revoke') {
          var revokeBtn = await waitFor(function () {
            return findVisible('button', 'Revoke');
          }, 5000);
          if (revokeBtn) { revokeBtn.click(); actionLog.push('revoke:clicked'); }
          else actionLog.push('revoke:missing');
        } else if (a === 'addOperator') {
          var addBtn = await waitFor(function () {
            return findVisible('button', '+ Add Operator');
          }, 5000);
          if (addBtn) { addBtn.click(); actionLog.push('addOperator:clicked'); }
          else actionLog.push('addOperator:missing');
        } else if (a === 'accept') {
          var acceptBtn = await waitFor(function () {
            return findVisible('button', 'Accept Invitation');
          }, 5000);
          if (acceptBtn) { acceptBtn.click(); actionLog.push('accept:clicked'); }
          else actionLog.push('accept:missing');
        } else {
          actionLog.push(a + ':unknown');
        }
      } catch (e) {
        actionLog.push(a + ':error:' + String(e && e.message).slice(0, 120));
      }
      await wait(700);
    }
  }

  /* ─────────────────────── measurement ───────────────────────────────── */

  function describe(el) {
    var cls = (typeof el.className === 'string' ? el.className : '')
      .trim().split(/\s+/).slice(0, 5).join('.');
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (cls) s += '.' + cls;
    return s.slice(0, 170);
  }

  function textOf(el) {
    var t = ((el.textContent || '').replace(/\s+/g, ' ').trim()) ||
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return t.slice(0, 120);
  }

  // An ancestor INSIDE <body> that clips/scrolls horizontally. html/body
  // themselves are deliberately NOT considered: their pre-existing
  // overflow-x:hidden rules must not mask genuine element overflow.
  function clippedByAncestor(el) {
    var p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      var ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      p = p.parentElement;
    }
    return false;
  }

  function round(n) { return Math.round(n * 10) / 10; }

  function measure() {
    var vw = document.documentElement.clientWidth;
    var overflow = [];
    var clipped = [];
    var scrollables = [];
    var small = [];
    var all = document.querySelectorAll('body *');

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (cs.pointerEvents === 'none') continue;
      if (parseFloat(cs.opacity) < 0.05) continue;

      var r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;

      if (!clippedByAncestor(el) && (r.right > vw + 1 || r.left < -1)) {
        overflow.push({
          el: describe(el),
          tag: el.tagName.toLowerCase(),
          left: round(r.left),
          right: round(r.right),
          w: round(r.width),
          text: textOf(el),
          html: (el.outerHTML || '').slice(0, 180),
        });
      }

      if (el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0) {
        var ox = cs.overflowX;
        if (ox === 'auto' || ox === 'scroll') {
          scrollables.push({ el: describe(el), scrollW: el.scrollWidth, clientW: el.clientWidth });
        } else if (ox === 'hidden') {
          // text-overflow: ellipsis = deliberate truncation, not a hard cut.
          if (cs.textOverflow !== 'ellipsis') {
            // Find the worst descendant sticking out past this container so the
            // report can name the actual offender, not just the clipper.
            var cRect = el.getBoundingClientRect();
            var worst = null;
            var kids = el.querySelectorAll('*');
            for (var k = 0; k < kids.length; k++) {
              var kd = kids[k];
              var kcs = getComputedStyle(kd);
              if (kcs.display === 'none' || kcs.visibility === 'hidden') continue;
              if (kcs.pointerEvents === 'none' || parseFloat(kcs.opacity) < 0.05) continue;
              var kText = (kd.textContent || '').replace(/\s+/g, ' ').trim();
              if (!kText && (kd.getAttribute('aria-hidden') === 'true' || getComputedStyle(kd).position === 'absolute')) continue;
              // Skip descendants properly contained by an intermediate scroller
              // (their layout rects extend past it, but the scroller clips/scrolls them).
              var blocked = false;
              for (var a = kd.parentElement; a && a !== el; a = a.parentElement) {
                var ao = getComputedStyle(a).overflowX;
                if (ao === 'auto' || ao === 'scroll' || ao === 'hidden' || ao === 'clip') { blocked = true; break; }
              }
              if (blocked) continue;
              var kr = kd.getBoundingClientRect();
              if (kr.width < 1 && kr.height < 1) continue;
              var spillR = kr.right - (cRect.right - Math.max(0, parseFloat(cs.paddingRight) || 0));
              if ((!worst || spillR > worst.spill) && spillR > 4) {
                var pR = kd.parentElement ? kd.parentElement.getBoundingClientRect() : null;
                var gR = kd.parentElement && kd.parentElement.parentElement ? kd.parentElement.parentElement.getBoundingClientRect() : null;
                var ps = kd.previousElementSibling ? kd.previousElementSibling.getBoundingClientRect() : null;
                worst = {
                  spill: round(spillR),
                  el: describe(kd),
                  text: textOf(kd),
                  html: (kd.outerHTML || '').slice(0, 160),
                  rect: { l: round(kr.left), r: round(kr.right), w: round(kr.width) },
                  prevSib: ps ? { l: round(ps.left), r: round(ps.right), w: round(ps.width), cls: (kd.previousElementSibling.className || '').toString().slice(0, 140), txt: textOf(kd.previousElementSibling).slice(0, 80) } : null,
                  parent: pR ? { l: round(pR.left), r: round(pR.right), w: round(pR.width), cls: (kd.parentElement.className || '').toString().slice(0, 120) } : null,
                  grand: gR ? { l: round(gR.left), r: round(gR.right), w: round(gR.width), cls: (kd.parentElement.parentElement.className || '').toString().slice(0, 120) } : null,
                  clipRect: { l: round(cRect.left), r: round(cRect.right), w: round(cRect.width) },
                };
              }
            }
            if (worst) {
              clipped.push({
                el: describe(el),
                scrollW: el.scrollWidth,
                clientW: el.clientWidth,
                delta: el.scrollWidth - el.clientWidth,
                text: textOf(el),
                parentHtml: (el.parentElement && el.parentElement.outerHTML || '').slice(0, 220),
                worst: worst,
              });
            }
          }
        }
      }
    }

    // Touch targets — PHONE LAYOUT only, gated on the same media query
    // Tailwind's md: breakpoint uses (Chrome's clientWidth can sit 6px below
    // the window width because of the classic scrollbar).
    var phoneLayout = !window.matchMedia('(min-width: 768px)').matches;
    if (phoneLayout) {
      var inter = document.querySelectorAll(
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]'
      );
      for (var j = 0; j < inter.length; j++) {
        var t = inter[j];
        var tcs = getComputedStyle(t);
        if (tcs.display === 'none' || tcs.visibility === 'hidden') continue;
        if (tcs.pointerEvents === 'none') continue;
        var tr = t.getBoundingClientRect();
        if (tr.width < 1 || tr.height < 1) continue;
        // A checkbox/radio whose whole label is clickable is one target —
        // measure the label instead of the 20px box.
        var hardEl = t;
        var probeRect = tr;
        if (t.tagName === 'INPUT' && (t.type === 'checkbox' || t.type === 'radio')) {
          var lbl = t.id ? document.querySelector('label[for="' + CSS.escape(t.id) + '"]') : t.closest('label');
          if (lbl) {
            var lr = lbl.getBoundingClientRect();
            if (lr.width >= 24 && lr.height >= 24) {
              hardEl = lbl;
              probeRect = lr;
            }
          }
        }
        if (tr.width < 44 - 0.5 || tr.height < 44 - 0.5) {
          var hard = hardEl === t && (tr.width < 24 || tr.height < 24);
          small.push({
            el: describe(t),
            tag: t.tagName.toLowerCase(),
            w: round(tr.width),
            h: round(tr.height),
            hard: hard,
            labelTarget: hardEl !== t ? round(lr.width) + 'x' + round(lr.height) : null,
            inScroll: clippedByAncestor(t),
            text: textOf(t),
          });
        }
      }
    }

    return {
      vw: vw,
      innerW: window.innerWidth,
      docScrollW: document.documentElement.scrollWidth,
      overflow: overflow,
      clipped: clipped,
      scrollables: scrollables,
      smallTargets: small,
      count: all.length,
    };
  }

  /* ──────────────────────── publish result ───────────────────────────── */

  var samples = [];
  var actionStarted = false;

  function publish() {
    var finalSample = samples.length ? samples[samples.length - 1] : null;
    var result = {
      url: location.pathname + location.search,
      role: role,
      dark: dark,
      seed: seed,
      actions: actions,
      actionLog: actionLog,
      dpr: window.devicePixelRatio,
      readyState: document.readyState,
      fonts: document.fonts ? document.fonts.status : 'n/a',
      errors: errors.slice(0, 20),
      apiHits: apiHits.slice(0, 40),
      first: samples[0] || null,
      final: finalSample,
      sampled: samples.length,
    };
    try {
      var json = JSON.stringify(result);
      document.documentElement.setAttribute(
        'data-audit',
        btoa(unescape(encodeURIComponent(json)))
      );
    } catch (e) {
      document.documentElement.setAttribute('data-audit-error', String(e));
    }
  }

  // Kick off (real time — run.mjs drives the page over CDP): actions at
  // 1.2s, sample #1 at 3s, authoritative sample #2 at 5.5s — but sample #2
  // additionally waits for document.fonts.ready (Google Fonts swap) so icon
  // text placeholders can never fake an overflow.
  setTimeout(function () {
    if (actions.length) {
      actionStarted = true;
      runActions().catch(function (e) {
        actionLog.push('runner:error:' + String(e && e.message).slice(0, 120));
      });
    }
  }, 1200);

  setTimeout(function () { samples.push(measure()); }, 3000);

  setTimeout(function () {
    var took = false;
    function take() {
      if (took) return;
      took = true;
      samples.push(measure());
      publish();
    }
    if (!document.fonts || document.fonts.status === 'loaded') return take();
    var t = setTimeout(take, 3000); // never hang on fonts
    document.fonts.ready.then(function () { clearTimeout(t); take(); }).catch(function () {
      clearTimeout(t); take();
    });
  }, 5500);
})();
