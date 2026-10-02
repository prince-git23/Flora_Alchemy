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

  /*
   * Fail loudly. An uncaught error during probe init used to mean the publish
   * timers never got scheduled, so every run reported a silent 30s "timeout
   * waiting for data-audit" — a single undefined fixture constant once failed
   * the entire matrix. Surface the real message instead; run.mjs reads
   * data-audit-error and reports it as "publish failed: <message>".
   */
  function fatally(e) {
    try {
      document.documentElement.setAttribute(
        'data-audit-error',
        String((e && e.message) || e).slice(0, 300)
      );
    } catch (ignore) { /* storage/document unavailable */ }
  }
  window.addEventListener('error', function (ev) { fatally(ev.error || ev.message); });

  var params = new URLSearchParams(location.search);
  // Phase 20.6.6 — a third staff identity: 'plainadmin' is an administrator
  // WITHOUT the owner designation (isOwner:false), so the role-scoped nav,
  // the owner-guard dossier and the non-owner portal home stay covered.
  var roleParam = params.get('role');
  var role = roleParam === 'handler' ? 'handler' : roleParam === 'plainadmin' ? 'plainadmin' : 'admin';
  var dark = params.get('dark') === '1';
  var seed = params.get('seed') !== '0';
  var actions = (params.get('actions') || '').split(',').map(function (s) {
    return s.trim();
  }).filter(Boolean);
  // Portal-context probe: ?actions=login&as=owner|admin|handler|customer —
  // types that identity into whichever portal login page is on screen.
  var loginAs = params.get('as');

  var HOUR = 3600000;
  var now = Date.now();
  function iso(ms) { return new Date(ms).toISOString(); }
  function daysAgo(d) { return iso(now - d * 24 * HOUR); }
  function hoursAhead(h) { return iso(now + h * HOUR); }

  /* ────────────────────────────── errors ─────────────────────────────── */

  var errors = [];
  // React reports a render failure through console.error, NOT through
  // window.onerror — which is exactly how a crashing route once shipped green.
  // Capture the console too so a boundary render carries its own reason.
  var consoleErrors = [];
  var realConsoleError = console.error ? console.error.bind(console) : null;
  console.error = function () {
    try {
      var parts = Array.prototype.slice.call(arguments).map(function (arg) {
        if (typeof arg === 'string') return arg;
        if (arg && (arg.stack || arg.message)) return arg.stack || arg.message;
        try { return JSON.stringify(arg); } catch (e) { return String(arg); }
      });
      if (consoleErrors.length < 12) consoleErrors.push(parts.join(' ').slice(0, 600));
    } catch (ignore) { /* never let logging break the probe */ }
    if (realConsoleError) realConsoleError.apply(null, arguments);
  };
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
              // Phase 21.8 — `portal` mirrors what POST /auth/login returns, so
              // the portal-aware shell resolves without a round trip.
              portal: 'staff',
              staffId: 'HND-0007',
              roleLabel: 'Handler',
              department: 'Atelier Floor',
              loggedInAt: iso(now),
            }
          : role === 'plainadmin'
            ? {
                token: 'audit-token',
                id: 'u-admin-02',
                email: 'kavya.reddy@floraalchemy.in',
                name: 'Kavya Reddy',
                role: 'admin',
                isOwner: false,
                portal: 'admin',
                staffId: 'ADM-0002',
                roleLabel: 'Administrator',
                department: 'Operations',
                loggedInAt: iso(now),
              }
            : {
                token: 'audit-token',
                id: 'u-owner-01',
                email: 'aditya.rao@floraalchemy.in',
                name: 'Aditya Rao',
                role: 'admin',
                isOwner: true,
                portal: 'owner',
                // The owner carries an OWN- badge, never an ADM- one — the
                // server derives this in staffIdentity.staffIdFor.
                staffId: 'OWN-0001',
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

  /* ── Phase 23 — Staff Action Center work sources ──
     The Action Center aggregates records the workspace already owns, so the
     fixtures are the same order/inventory rows above plus a request queue and
     a conversation. Order FA-1206 and the lavender vial are deliberately the
     two entries whose MUTATION is refused (stale item / suspended account) so
     the failure path is exercised for real, against the shape the server
     returns — never a fabricated generic error. */
  var customRequests = [
    {
      _id: 'cr-audit-0001',
      description: 'Velvet peony keepsake with hand-bound wire stem for an anniversary.',
      occasion: 'Anniversary',
      budget: '₹4,000',
      colors: 'blush, sage',
      desiredDate: hoursAhead(30),
      status: 'pending',
      adminNotes: '',
      createdAt: daysAgo(1),
    },
    {
      _id: 'cr-audit-0002',
      description: 'Letterpress deckled stationery set, 40 cards, botanical motif.',
      occasion: 'Wedding',
      budget: '₹7,500',
      colors: 'ivory, gold',
      desiredDate: hoursAhead(4),
      status: 'reviewing',
      adminNotes: 'Sourcing deckle stock',
      createdAt: daysAgo(3),
    },
  ];

  var conversations = [
    { id: 'conv-audit-1', orderId: 'FA-1201', customerId: 'c-1', status: 'open', unreadCount: 2, lastMessageAt: iso(now - 2 * HOUR) },
    { id: 'conv-audit-2', orderId: 'FA-1203', customerId: 'c-3', status: 'open', unreadCount: 0, lastMessageAt: iso(now - 30 * HOUR) },
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
    staffId: 'OWN-0001',
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
    // Phase 22.4 — workspace provenance (directory column + dossier).
    workspace: { id: 'ws-002', slug: 'kavya-botanica', name: 'Kavya Botanica', status: 'ACTIVE' },
    businessName: 'Kavya Botanica',
    applicationId: 'app-7',
    applicationRef: 'APP-MF9UMM66B9',
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

  /* ── Phase 21.8 — OWNER PORTAL directory (ownerController.listAdministrators) ──
     The owner directory lists administrators AND live administrator invitations
     as `kind: 'invitation'` rows with server-derived lifecycle rights. */

  var suspendedAdminRow = staffRow({
    id: 'u-admin-03',
    name: 'Nandini Menon',
    initials: 'NM',
    email: 'nandini.menon@floraalchemy.in',
    role: 'admin',
    roleLabel: 'Administrator',
    roleBadge: 'ADMIN',
    staffId: 'ADM-0003',
    department: 'Fulfilment',
    status: 'SUSPENDED',
    createdAt: daysAgo(220),
    joinedLabel: '7 months ago',
    lastActiveAt: iso(now - 21 * 24 * HOUR),
    lastActiveLabel: '3 weeks ago',
    suspension: { reason: 'Extended leave', note: 'Cover arranged with the operations lead.', at: iso(now - 21 * 24 * HOUR) },
    actions: { canReactivate: true },
    // Phase 22.4 — workspace provenance.
    workspace: { id: 'ws-003', slug: 'nandini-atelier', name: 'Nandini Atelier', status: 'SUSPENDED' },
    businessName: 'Nandini Atelier',
    applicationId: 'app-6',
    applicationRef: 'APP-MF9VNN88D1',
  });

  function ownerAdminInvite(o) {
    return Object.assign(
      {
        kind: 'invitation',
        role: 'admin',
        roleLabel: 'Administrator',
        roleBadge: 'ADMINISTRATOR',
        department: 'Operations',
        phone: '',
        isOwner: false,
        isFixture: false,
        joinedLabel: '2 days ago',
        lastActiveAt: iso(now - 2 * 24 * HOUR),
        lastActiveLabel: 'Invitation pending',
        invitedByName: 'Aditya Rao',
        expiresLabel: 'Expires 29 Sept',
        resendCount: 0,
        actions: { canResend: true, canRevoke: true, note: '' },
      },
      o
    );
  }

  var ownerAdminInviteRow = ownerAdminInvite({
    id: 'INV-0AD001',
    name: 'Devika Menon',
    initials: 'DM',
    email: 'devika.m@floraalchemy.in',
    staffId: 'INV-0AD001',
    status: 'INVITED',
    // Phase 22.4 — the business this invitation will provision on activation.
    businessName: 'Devika Preserves',
    workspace: { status: 'PENDING' },
    applicationId: 'app-4',
    applicationRef: 'APP-MF9XQR33H6',
  });

  var ownerAdminRevokedRow = ownerAdminInvite({
    id: 'INV-0AD002',
    name: 'Sana Kapoor',
    initials: 'SK',
    email: 'sana.kapoor@floraalchemy.in',
    staffId: 'INV-0AD002',
    status: 'REVOKED',
    lastActiveLabel: 'Invitation pending',
    expiresLabel: 'Expired 22 Sept',
    actions: { canResend: false, canRevoke: false, note: 'This invitation is no longer actionable.' },
  });

  var ownerAdminRows = [
    Object.assign({}, ownerRow, { invitedByName: '' }),
    Object.assign({}, adminRow, { invitedByName: 'Aditya Rao' }),
    suspendedAdminRow,
    ownerAdminInviteRow,
    ownerAdminRevokedRow,
  ];

  var ownerAdminCounts = {
    all: ownerAdminRows.length,
    owners: 1,
    active: 2,
    invited: 1,
    suspended: 1,
    expired: 0,
    pendingApplications: 2,
    pendingInvitations: 1,
  };

  var ownerOverview = {
    applications: { all: 14, pending: 2, approved: 6, rejected: 3, invited: 1, activated: 2 },
    administrators: { total: 3, active: 2, suspended: 1 },
    handlers: { total: 3, active: 2, suspended: 1 },
    pendingInvitations: 1,
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

  /* ── Phase 20.6.6 — admin application dossiers (adminApplicationController) ── */

  function application(id, appId, name, email, status, ageDays, extras) {
    var created = now - ageDays * 24 * HOUR;
    var reviewable = status === 'SUBMITTED' || status === 'PENDING_REVIEW';
    var slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return Object.assign(
      {
        id: id,
        applicationId: appId,
        name: name,
        email: email,
        phone: '+91 98765 40' + appId.slice(-2),
        // Phase 22.4 — business identity the owner is reviewing.
        businessName: name.split(' ')[0] + ' Botanica',
        preferredSlug: '',
        proposedSlug: slugBase + '-botanica',
        reason:
          'I have run fulfilment for a small-batch studio for four years and want to steward the order and inventory side of the atelier with the same care it gives its craft.',
        background:
          'Operations & fulfilment lead at a boutique gifting studio. Comfortable with order pipelines, stock ledgers, dispatch QA and customer comms.',
        status: status,
        reviewedBy: reviewable ? null : 'u-owner-01',
        reviewedByName: reviewable ? '' : 'Aditya Rao',
        reviewedAt: reviewable ? null : iso(created + 6 * HOUR),
        reviewNote: reviewable ? '' : 'Reviewed against the atelier handbook.',
        createdAt: iso(created),
        updatedAt: iso(created + 6 * HOUR),
        canApprove: reviewable,
        canReject: reviewable,
      },
      extras || {}
    );
  }

  var applications = [
    application('app-1', 'APP-MFA3XK91Q2', 'Farah Qureshi', 'farah.qureshi@example.com', 'PENDING_REVIEW', 1),
    application('app-2', 'APP-MFA2ZW77P4', 'Joseph Mathew', 'joseph.mathew@example.com', 'SUBMITTED', 2),
    application('app-3', 'APP-MF9YTT55J8', 'Nandini Shah', 'nandini.shah@example.com', 'APPROVED', 5),
    application('app-4', 'APP-MF9XQR33H6', 'Imran Sheikh', 'imran.sheikh@example.com', 'INVITED', 6),
    application('app-5', 'APP-MF9WPP11F3', 'Ritu Desai', 'ritu.desai@example.com', 'REJECTED', 9, {
      reviewNote: 'No operations background for an administrator seat — invited to reapply after more experience.',
    }),
    application('app-6', 'APP-MF9VNN88D1', 'Sameer Kulkarni', 'sameer.kulkarni@example.com', 'EXPIRED', 12),
    application('app-7', 'APP-MF9UMM66B9', 'Ayesha Khan', 'ayesha.khan@example.com', 'ACTIVATED', 20),
  ];

  var applicationCounts = {
    all: applications.length,
    pending: 2,
    approved: 1,
    invited: 1,
    activated: 1,
    rejected: 1,
    expired: 1,
  };

  var applicationInvitation = {
    invitationId: 'INV-00B7C8',
    status: 'INVITED',
    expiresAt: hoursAhead(54),
    consumedAt: null,
    resendCount: 0,
  };

  function applicationFor(id) {
    for (var i = 0; i < applications.length; i++) {
      if (applications[i].id === id || applications[i].applicationId === id) return applications[i];
    }
    return applications[0];
  }

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

  // Phase 22.4 — ADMIN invitation: activating it provisions a workspace, so
  // the landing shows the approved business identity and the activation form
  // carries the editable workspace-address field.
  var adminInvitationView = {
    role: 'admin',
    roleLabel: 'Administrator',
    recipientEmail: 'devika.m@floraalchemy.in',
    recipientName: 'Devika Menon',
    department: null,
    applicantName: 'Devika Menon',
    applicationId: 'APP-MF9XQR33H6',
    invitationId: 'INV-0AD001',
    invitedByName: 'Aditya Rao',
    workspaceName: 'Devika Preserves',
    workspaceSlug: 'devika-preserves',
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

  /* ───────────────── portal identities (login probes) ─────────────────── */
  // Mirrors the fixtures the seeded sessions use (see the session seeding
  // below) so a signed-in probe and a typed-in probe are the same person.
  var LOGIN_IDENTITIES = {
    owner: {
      id: 'u-owner-01',
      email: 'aditya.rao@floraalchemy.in',
      name: 'Aditya Rao',
      role: 'admin',
      isOwner: true,
      portal: 'owner',
      staffId: 'OWN-0001',
      roleLabel: 'Owner',
      department: 'Atelier Direction',
    },
    admin: {
      id: 'u-admin-02',
      email: 'kavya.reddy@floraalchemy.in',
      name: 'Kavya Reddy',
      role: 'admin',
      isOwner: false,
      portal: 'admin',
      staffId: 'ADM-0002',
      roleLabel: 'Administrator',
      department: 'Operations',
    },
    handler: {
      id: 'u-handler-07',
      email: 'meera.nambiar@floraalchemy.in',
      name: 'Meera Nambiar',
      role: 'handler',
      isOwner: false,
      portal: 'staff',
      staffId: 'HND-0007',
      roleLabel: 'Handler',
      department: 'Atelier Floor',
    },
    customer: {
      id: 'u-customer-09',
      email: 'shreya.kapoor@example.com',
      name: 'Shreya Kapoor',
      role: 'customer',
      isOwner: false,
      portal: null,
    },
  };

  function portalHome(portal) {
    if (portal === 'owner') return '/owner/dashboard';
    if (portal === 'staff') return '/staff/dashboard';
    return '/admin/dashboard';
  }

  // backend/utils/portals.js evaluatePortalAccess — the server's policy, kept
  // verbatim so a refused portal in the audit means the same thing as a
  // refused portal in production.
  function portalAllowed(identity, portal) {
    if (!identity) return false;
    if (identity.role === 'customer') return false;
    if (portal === 'owner') return identity.role === 'admin' && identity.isOwner === true;
    if (portal === 'admin') return identity.role === 'admin';
    if (portal === 'staff') return identity.role === 'handler';
    return false;
  }

  function portalRefusalMessage(portal) {
    if (portal === 'owner') return 'The Owner Portal is restricted to the business owner.';
    if (portal === 'staff') return 'The Staff Portal is for handler accounts. Use your Administrator or Owner portal.';
    return 'This account does not have administrator access.';
  }

  /** The identity a login attempt proves: the email local part (owner@…). */
  function identityForLogin(body) {
    var email = String((body && body.email) || '').toLowerCase();
    return LOGIN_IDENTITIES[email.split('@')[0]] || null;
  }

  /** A refusal carries the HTTP status so the probe can exercise the real
      error branch of the client instead of a 200 with a failure envelope. */
  function refused(status, code, message) {
    return { __httpStatus: status, success: false, code: code, message: message };
  }

  function fixtureFor(pathname, method, body) {
    // pathname is the API path AFTER the /api prefix, e.g. '/admin/staff'.
    var p = String(pathname || '/');
    var m = String(method || 'GET').toUpperCase();

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
      // Mirrors POST /api/auth/login: the identity comes from the credential,
      // the SERVER derives the portal it belongs to, and a portal it does not
      // belong to is refused with 403 PORTAL_FORBIDDEN — while an identity the
      // policy DOES permit (an owner reaching the Administrator Portal) still
      // authenticates and is told which portal it belongs to.
      var identity = identityForLogin(body);
      if (!identity) {
        return refused(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      }
      if (identity.role === 'customer') {
        return refused(403, 'PORTAL_FORBIDDEN', 'This portal is for Flora Alchemy staff accounts only.');
      }
      var wanted = body && body.portal;
      if (wanted && !portalAllowed(identity, wanted)) {
        return refused(403, 'PORTAL_FORBIDDEN', portalRefusalMessage(wanted));
      }
      return {
        success: true,
        token: 'audit-token',
        user: identity,
        redirectTo: portalHome(identity.portal),
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

    // Phase 21.8 — owner-only surfaces (/owner/*).
    if (p === '/owner/overview') return { success: true, overview: ownerOverview, activity: activityEvents };
    if (p === '/owner/administrators') return { success: true, administrators: ownerAdminRows, counts: ownerAdminCounts };

    // Phase 20.6.6 — owner admin-application flow.
    if (p === '/admin-applications') {
      // POST is the PUBLIC intake (returns the filed dossier); GET is the
      // owner ledger (list + whole-ledger counts).
      if (m === 'POST') return { success: true, message: 'Application received.', application: applications[0] };
      return {
        success: true,
        applications: applications,
        counts: applicationCounts,
        page: 1,
        total: applications.length,
        hasMore: false,
      };
    }
    if (/^\/admin-applications\/[^/]+\/approve$/.test(p)) {
      var approveId = decodeURIComponent(p.split('/')[2]);
      var approvedBase = applicationFor(approveId);
      return {
        success: true,
        message: 'Application approved.',
        link: location.origin + '/admin/activate/audit-issued-' + approveId,
        application: Object.assign({}, approvedBase, {
          status: 'APPROVED',
          canApprove: false,
          canReject: false,
          reviewedByName: 'Aditya Rao',
          reviewedAt: iso(now),
        }),
        invitation: applicationInvitation,
      };
    }
    if (/^\/admin-applications\/[^/]+\/reject$/.test(p)) {
      var rejectId = decodeURIComponent(p.split('/')[2]);
      var rejectedBase = applicationFor(rejectId);
      return {
        success: true,
        message: 'Application rejected.',
        application: Object.assign({}, rejectedBase, {
          status: 'REJECTED',
          canApprove: false,
          canReject: false,
          reviewedByName: 'Aditya Rao',
          reviewedAt: iso(now),
          reviewNote: 'Not the right fit for the atelier at this time.',
        }),
      };
    }
    if (/^\/admin-applications\/[^/]+$/.test(p)) {
      var dossierId = decodeURIComponent(p.split('/')[2]);
      var app = applicationFor(dossierId);
      var linked =
        app.status === 'APPROVED' || app.status === 'INVITED' || app.status === 'ACTIVATED' || app.status === 'EXPIRED';
      return { success: true, application: app, invitation: linked ? applicationInvitation : null };
    }
    if (/^\/invitations\/[^/]+$/.test(p)) {
      // Phase 22.4 — audit-admin-token carries the ADMIN invitation (with the
      // approved workspace identity); every other token resolves the handler
      // invitation the activation screens have always rendered.
      var inviteToken = decodeURIComponent(p.split('/')[2]);
      return { success: true, invitation: inviteToken.indexOf('admin') >= 0 ? adminInvitationView : invitationView };
    }
    if (/^\/invitations\/[^/]+\/activate$/.test(p)) {
      return {
        success: true,
        account: { id: 'u-handler-07', email: 'rohan.das@example.com', name: 'Rohan Das', role: 'handler' },
        workspace: null,
      };
    }
    // Phase 22.4 — public shop directory (GET /api/shops/:slug). The resolver
    // needs a real shop payload to reach the ready state; anything else falls
    // through to the generic envelope above (gate renders its honest error).
    if (/^\/shops\/[^/]+\/products$/.test(p)) {
      var spSlug = decodeURIComponent(p.split('/')[2]).toLowerCase();
      return {
        success: true,
        shop: { slug: spSlug, displayName: 'Maison Botanica' },
        products: [
          { slug: 'heirloom-rose-box', name: 'Heirloom Rose Keepsake Box', description: 'Preserved garden roses set in a hand-finished wooden box.', price: 2450, image: null, inStock: true, availability: 'In Stock' },
          { slug: 'botanical-candle-trio', name: 'Botanical Candle Trio', description: 'Three hand-poured soy candles with pressed flora.', price: 1850, image: null, inStock: true, availability: 'In Stock' },
          { slug: 'pressed-flora-frame', name: 'Pressed Flora Memory Frame', description: 'A framed arrangement of pressed seasonal blooms.', price: 3200, image: null, inStock: false, availability: 'Made to Order' },
        ],
      };
    }
    if (/^\/shops\/[^/]+\/collections$/.test(p)) {
      var scSlug = decodeURIComponent(p.split('/')[2]).toLowerCase();
      return {
        success: true,
        shop: { slug: scSlug, displayName: 'Maison Botanica' },
        collections: [
          { slug: 'anniversary', name: 'Anniversary' },
          { slug: 'housewarming', name: 'Housewarming' },
        ],
      };
    }
    if (/^\/shops\/[^/]+\/settings$/.test(p)) {
      var ssSlug = decodeURIComponent(p.split('/')[2]).toLowerCase();
      return {
        success: true,
        shop: { slug: ssSlug, displayName: 'Maison Botanica' },
        settings: { storeName: 'Maison Botanica', storeTagline: 'Keepsakes, pressed and preserved', currency: 'INR' },
      };
    }
    if (/^\/shops\/[^/]+$/.test(p)) {
      var shopSlug = decodeURIComponent(p.split('/')[2]).toLowerCase();
      return { success: true, shop: { slug: shopSlug, displayName: 'Maison Botanica' } };
    }
    if (p === '/notifications') return { success: true, notifications: notifications, unreadCount: 1 };
    if (p === '/notifications/unread-count') return { success: true, unreadCount: 1 };
    if (p === '/custom-requests') return { success: true, requests: customRequests };
    if (p === '/conversations') return { success: true, conversations: conversations };

    /* ── Phase 23 — Staff Action Center mutations ──
       The work items the Action Center renders each map to one of these
       endpoints. The refusals here are the SERVER's own shapes (404 for a
       work item that vanished, 403 for a suspended operator, 403
       ACTION_NOT_PERMITTED for administrator-only work), so the failure path
       is exercised against real contracts rather than a fabricated error. */
    if (m === 'PATCH' && /^\/orders\/[^/]+\/status$/.test(p)) {
      var workOrderId = decodeURIComponent(p.split('/')[2]);
      var wantedStatus = body && body.status;
      var workOrder = null;
      for (var wo = 0; wo < orders.length; wo += 1) {
        if (orders[wo].orderId === workOrderId) workOrder = orders[wo];
      }
      if (!workOrder) return refused(404, 'ORDER_NOT_FOUND', 'Order not found.');
      // Stands in for a work item that was reassigned or removed between
      // render and click — the real server answers 404 ORDER_NOT_FOUND.
      if (workOrderId === 'FA-1206') return refused(404, 'ORDER_NOT_FOUND', 'Order not found.');
      workOrder.orderStatus = wantedStatus;
      workOrder.status = wantedStatus;
      workOrder.statusHistory = (workOrder.statusHistory || []).concat([
        { status: wantedStatus, note: (body && body.note) || '', changedBy: 'Meera Nambiar', at: iso(Date.now()) },
      ]);
      return { success: true, order: workOrder, availableNext: null };
    }
    if (m === 'POST' && /^\/inventory\/[^/]+\/adjust$/.test(p)) {
      var invSlug = decodeURIComponent(p.split('/')[2]);
      var invRow = null;
      for (var ir = 0; ir < inventory.length; ir += 1) {
        if (inventory[ir].productSlug === invSlug) invRow = inventory[ir];
      }
      if (!invRow) return refused(404, 'NOT_FOUND', 'Inventory row not found.');
      // A suspended operator is refused the mutation by protect's re-read; the
      // shell must say THAT, never blame the connection.
      if (invSlug === 'lavender-glass-vial') {
        return refused(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended. Contact an administrator.');
      }
      var moveType = (body && body.type) || 'adjustment';
      var magnitude = Math.abs(Number(body && body.quantity) || 0);
      invRow.currentStock = invRow.currentStock + (moveType === 'remove' || moveType === 'sale' ? -magnitude : magnitude);
      invRow.updatedAt = iso(Date.now());
      return { success: true, inventory: invRow };
    }
    if (m === 'PATCH' && /^\/custom-requests\/[^/]+\/status$/.test(p)) {
      var crId = decodeURIComponent(p.split('/')[2]);
      var crRow = null;
      for (var cr = 0; cr < customRequests.length; cr += 1) {
        if (customRequests[cr]._id === crId) crRow = customRequests[cr];
      }
      if (!crRow) return refused(404, 'NOT_FOUND', 'Custom request not found.');
      // Mirrors backend/utils/operationalActions.js — declining is admin work.
      if (body && body.status === 'declined') {
        return refused(
          403,
          'ACTION_NOT_PERMITTED',
          'Declining a custom request is a business decision reserved for administrators.'
        );
      }
      crRow.status = body.status;
      if (body.adminNotes !== undefined) crRow.adminNotes = body.adminNotes;
      return { success: true, request: crRow };
    }
    if (m === 'PATCH' && /^\/conversations\/[^/]+\/read$/.test(p)) {
      var convId = decodeURIComponent(p.split('/')[2]);
      for (var cv = 0; cv < conversations.length; cv += 1) {
        if (conversations[cv].id === convId) conversations[cv].unreadCount = 0;
      }
      return { success: true };
    }
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
    var method = (init && init.method) || 'GET';
    apiHits.push(method + ' ' + path);
    var sent = null;
    if (init && typeof init.body === 'string') {
      try { sent = JSON.parse(init.body); } catch (e) { sent = null; }
    }
    var body = fixtureFor(path, method, sent);
    // Fixtures answer 200 unless they explicitly mark a refusal.
    var status = 200;
    if (body && body.__httpStatus) {
      status = body.__httpStatus;
      delete body.__httpStatus;
    }
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
  // Set by the 'login' action: where a typed-in sign-in actually ended.
  var loginState = null;

  /** Drive a React-controlled input/select the way a human would. */
  function setNativeValue(el, value) {
    var proto =
      el.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Follow a login attempt to its end state. Three outcomes matter and each
   * one is a different claim:
   *   · refused  — the server refused the portal: the page stays on the login
   *                route with an error and NO portal shell rendered;
   *   · mismatch — the identity authenticated but belongs elsewhere: a notice
   *                naming its portal, then the hand-over;
   *   · landed   — the account's own portal home rendered.
   */
  async function watchLogin(startPath) {
    var out = {
      as: loginAs || 'owner',
      startPath: startPath,
      landedPath: null,
      refused: null,
      mismatchNotice: null,
      sawMismatch: false,
    };
    var deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      var notice = document.querySelector('[data-login-state="mismatch"]');
      if (notice && !out.sawMismatch) {
        out.sawMismatch = true;
        out.mismatchNotice = (notice.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        // The notice is on screen for only a couple of seconds before the
        // hand-over, so the scheduled samples would miss it: measure it here.
        try {
          out.mismatchOverflow = (measure().overflow || []).map(function (o) {
            return o.el + ' [left=' + o.left + ' right=' + o.right + ' vw=' + o.vw + ']';
          });
        } catch (e) {
          out.mismatchOverflow = null;
        }
      }
      var failure = document.querySelector('[data-login-state="error"]');
      if (failure) {
        out.refused = (failure.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        break;
      }
      if (location.pathname !== startPath) {
        out.landedPath = location.pathname;
        break;
      }
      await wait(120);
    }
    // Let the destination route and its shell finish rendering.
    if (out.landedPath) await wait(900);
    return out;
  }

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
        } else if (a === 'owner-inv-dossier') {
          // Owner directory — open a LIVE administrator invitation row so the
          // dossier renders its server-derived Resend/Revoke controls.
          var invRow = await waitFor(function () {
            return findVisible('button', 'Devika Menon') || findVisible('tr', 'Devika Menon');
          }, 6000);
          if (invRow) { invRow.click(); actionLog.push('owner-inv-dossier:clicked:' + invRow.tagName); }
          else actionLog.push('owner-inv-dossier:missing');
        } else if (a === 'owner-admin-dossier') {
          // Owner directory — open an ACTIVE administrator row (Suspend).
          var admRow = await waitFor(function () {
            return findVisible('button', 'Kavya Reddy') || findVisible('tr', 'Kavya Reddy');
          }, 6000);
          if (admRow) { admRow.click(); actionLog.push('owner-admin-dossier:clicked:' + admRow.tagName); }
          else actionLog.push('owner-admin-dossier:missing');
        } else if (a === 'owner-suspend') {
          var ownerSus = await waitFor(function () {
            return findVisible('button', 'Suspend Staff Member');
          }, 5000);
          if (ownerSus) { ownerSus.click(); actionLog.push('owner-suspend:clicked'); }
          else actionLog.push('owner-suspend:missing');
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
        } else if (a === 'app-dossier') {
          // Open the first reviewable dossier from the ledger.
          var reviewBtn = await waitFor(function () {
            return findVisible('button', 'Review');
          }, 6000);
          if (reviewBtn) { reviewBtn.click(); actionLog.push('app-dossier:clicked'); }
          else actionLog.push('app-dossier:missing');
        } else if (a === 'app-approve') {
          // Dossier → approve dialog → confirm; lands on the one-time link view.
          var approveOpenBtn = await waitFor(function () {
            return findVisible('button', 'Approve Application');
          }, 6000);
          if (approveOpenBtn) {
            approveOpenBtn.click();
            var approveConfirmBtn = await waitFor(function () {
              return findVisible('button', 'Approve & Issue Invitation');
            }, 5000);
            if (approveConfirmBtn) { approveConfirmBtn.click(); actionLog.push('app-approve:confirmed'); }
            else actionLog.push('app-approve:confirm-missing');
          } else actionLog.push('app-approve:missing');
        } else if (a === 'app-reject') {
          // Dossier → reject dialog → real reason → confirm.
          var rejectOpenBtn = await waitFor(function () {
            return findVisible('button', 'Reject');
          }, 6000);
          if (rejectOpenBtn) {
            rejectOpenBtn.click();
            var reasonTa = await waitFor(function () { return document.getElementById('reject-reason'); }, 5000);
            if (reasonTa) {
              var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              nativeSet.call(reasonTa, 'Not the right fit for the atelier at this time.');
              reasonTa.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(250);
            }
            var rejectConfirmBtn = await waitFor(function () {
              return findVisible('button', 'Reject Application');
            }, 5000);
            if (rejectConfirmBtn) { rejectConfirmBtn.click(); actionLog.push('app-reject:confirmed'); }
            else actionLog.push('app-reject:confirm-missing');
          } else actionLog.push('app-reject:missing');
        } else if (a === 'login') {
          // Portal-context probe: type the requested identity into whichever
          // portal login page is on screen and submit it, then watch where the
          // app actually goes.
          var as = loginAs || 'owner';
          var emailInput = await waitFor(function () { return document.getElementById('portal-email'); }, 6000);
          var passInput = await waitFor(function () { return document.getElementById('portal-password'); }, 3000);
          if (emailInput && passInput) {
            var setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setValue.call(emailInput, as + '@portal.test');
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            setValue.call(passInput, 'audit-password');
            passInput.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(150);
            var submit = findVisible('button[type="submit"]');
            if (submit) {
              submit.click();
              actionLog.push('login:submitted:' + as);
              loginState = await watchLogin(location.pathname);
            } else {
              actionLog.push('login:submit-missing');
            }
          } else {
            actionLog.push('login:form-missing');
          }
        } else if (a === 'hop-to-shop') {
          // Phase 23 — client-side hop from the workspace address to the
          // legacy shared storefront. Regression guard for the empty-catalogue
          // bug: /shops/:slug hydrates NO global slices, so /shop must backfill
          // its critical products slice on navigation or it renders
          // "No gifts match these filters" with an empty store forever.
          var hopLink = await waitFor(function () {
            return findVisible('a[href="/shop"]', 'All Gifts') || findVisible('a[href="/shop"]');
          }, 6000);
          if (hopLink) {
            hopLink.click();
            actionLog.push('hop-to-shop:clicked');
            await wait(1600); // route backfill + ShopPage re-filter settle here
          } else {
            actionLog.push('hop-to-shop:missing');
          }
        } else if (a === 'work-filter-area' || a === 'work-filter-status') {
          // Action Center filters: the category selector is a FILTER over the
          // queue, not the extent of the handler's work.
          var filterId = a === 'work-filter-area' ? 'work-filter-area' : 'work-filter-status';
          var wanted = params.get(a === 'work-filter-area' ? 'area' : 'status') || 'all';
          var filterEl = await waitFor(function () { return document.getElementById(filterId); }, 6000);
          if (filterEl) {
            setNativeValue(filterEl, wanted);
            actionLog.push(a + ':' + wanted);
            await wait(400);
          } else {
            actionLog.push(a + ':missing');
          }
        } else if (a === 'work-advance' || a === 'work-movement') {
          // Execute a real work-item action on a real card and stop only once
          // the page has published an outcome (success or refusal).
          var targetKey = params.get('target') || '';
          var card = await waitFor(function () {
            return targetKey
              ? document.querySelector('[data-work-item="' + targetKey + '"]')
              : document.querySelector('[data-work-item]');
          }, 6000);
          if (!card) {
            actionLog.push(a + ':card-missing');
          } else {
            var primary =
              a === 'work-movement'
                ? card.querySelector('[data-work-action="inventory-adjust"]')
                : card.querySelector('[data-work-action="order-advance"]') ||
                  card.querySelector('[data-work-action="custom-request-status"]') ||
                  card.querySelector('[data-work-action="conversation-read"]');
            if (!primary) {
              actionLog.push(a + ':action-missing');
            } else {
              primary.click();
              actionLog.push(a + ':clicked');
              if (a === 'work-movement') {
                var confirmBtn = await waitFor(function () {
                  return card.querySelector('[data-work-action="inventory-confirm"]');
                }, 4000);
                if (confirmBtn) {
                  confirmBtn.click();
                  actionLog.push('work-movement:confirmed');
                } else {
                  actionLog.push('work-movement:confirm-missing');
                }
              }
              await waitFor(function () { return document.querySelector('[data-action-state]'); }, 8000);
              await wait(500);
            }
          }
        } else if (a === 'apply-submit') {
          // Empty submit on the public intake — client validation must render.
          var submitBtn = await waitFor(function () {
            return findVisible('button', 'Submit Application');
          }, 6000);
          if (submitBtn) { submitBtn.click(); actionLog.push('apply-submit:clicked'); }
          else actionLog.push('apply-submit:missing');
        } else {
          actionLog.push(a + ':unknown');
        }
      } catch (e) {
        actionLog.push(a + ':error:' + String(e && e.message).slice(0, 120));
      }
      await wait(700);
    }
  }

  /* ─────────────────── flow outcome (not just a click) ────────────────── */
  // A dispatched click proves nothing. The owner "Open →" defect clicked
  // perfectly and then threw inside a modal effect, so the route never
  // rendered; the harness still reported green because it only recorded
  // ':clicked'. These observations let the runner assert the END STATE of a
  // flow — and notice a route that fell into the error boundary.
  function observeFlow() {
    // NB: only ever called from publish() — this probe is injected at
    // document-start, so document.body does not exist yet at load time.
    var body = (document.body && document.body.innerText) || '';
    var dialog = document.querySelector('[role="dialog"]');
    var approve = document.querySelector('[data-approve-state]');
    var write = document.querySelector('[data-write-state]');
    var shell = document.querySelector('[data-portal-shell]');
    var loginMark = document.querySelector('[data-login-state]');
    // Phase 23 — Staff Action Center state.
    var workRoot = document.querySelector('[data-staff-work]');
    var workCountEl = document.querySelector('[data-work-count]');
    var workCards = Array.prototype.slice.call(document.querySelectorAll('[data-work-item]'));
    var actionEl = document.querySelector('[data-action-state]');
    return {
      dialogRendered: !!dialog,
      dialogLabelledBy: dialog ? dialog.getAttribute('aria-labelledby') : null,
      approveState: approve ? approve.getAttribute('data-approve-state') : null,
      writeState: write ? write.getAttribute('data-write-state') : null,
      rejectDialogOpen: !!document.getElementById('reject-reason'),
      // Portal context: which shell is on screen (server-derived session, not
      // the URL) and what a typed-in sign-in ended on.
      portalShell: shell ? shell.getAttribute('data-portal-shell') : null,
      loginState: loginMark ? loginMark.getAttribute('data-login-state') : null,
      login: loginState,
      pathname: location.pathname,
      ownerGate: /Owner Access Required/.test(body),
      workState: workRoot ? workRoot.getAttribute('data-staff-work') : null,
      workCount: workCountEl ? Number(workCountEl.getAttribute('data-work-count')) : null,
      workItems: workCards.map(function (el) { return el.getAttribute('data-work-item'); }).slice(0, 40),
      workAreas: workCards.map(function (el) { return el.getAttribute('data-work-area'); }).slice(0, 40),
      workStatuses: workCards.map(function (el) { return el.getAttribute('data-work-status'); }).slice(0, 40),
      actionState: actionEl ? actionEl.getAttribute('data-action-state') : null,
      actionCode: actionEl ? actionEl.getAttribute('data-action-code') : null,
      actionFeedback: actionEl
        ? (actionEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220)
        : null,
      // The route-level error boundary's own copy (RouteErrorBoundary.jsx).
      // If any of this is on screen, the page did NOT render.
      routeErrorBoundary: /Something went wrong on this page|This section failed to render|This page couldn.t load/.test(body),
      // Phase 23 — CATALOGUE CONSISTENCY probes.
      // shopCards: product cards on whichever catalogue surface is on screen
      //            (legacy /shop grid = article, /shops/:slug page = li).
      // shopEmpty: the two honest empty states — the legacy filter message and
      //            the workspace page's "no published products" copy.
      shopCards:
        document.querySelectorAll('article').length +
        document.querySelectorAll('section[aria-label="Products"] li').length,
      shopEmpty: /No gifts match these filters|no published products yet/i.test(body),
      shopShowLine: (body.match(/Showing \d+ handcrafted[^\n]*/) || [''])[0].slice(0, 80),
    };
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
    // Read the flow outcome NOW (not at injection time) — by 5.5s the DOM and
    // the action's end state both exist.
    var flow = observeFlow();
    var result = {
      url: location.pathname + location.search,
      role: role,
      dark: dark,
      seed: seed,
      actions: actions,
      actionLog: actionLog,
      login: loginState,
      flow: flow,
      dpr: window.devicePixelRatio,
      readyState: document.readyState,
      fonts: document.fonts ? document.fonts.status : 'n/a',
      errors: errors.slice(0, 20),
      consoleErrors: consoleErrors.slice(0, 12),
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
