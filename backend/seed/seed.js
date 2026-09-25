import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import {
  assertSafeDatabase,
  assertFixtureAccountsAllowed,
  classifyDatabase,
  describeDatabase,
} from '../utils/environmentGuard.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Collection from '../models/Collection.js';
import Inventory from '../models/Inventory.js';
import Order from '../models/Order.js';
import Settings from '../models/Settings.js';

/**
 * Fixture data mirrors the Phase 1/2 sample catalogue so the API returns the
 * same world the storefront prototype has been showing.
 *
 * DEMO DATA RULE: every fixture is flagged isFixture:true and is NEVER used
 * to auto-authenticate anyone. Logging in as the demo customer/admin requires
 * an explicit developer action on the login screens (quick-fill helpers).
 */

const FIXTURE_PRODUCTS = [
  { slug: 'dusty-rose-lavender-posy', name: 'The Dusty Rose & Lavender Dream Posy', sku: 'FA-DUSTYROS', price: 1850, category: 'Flowers & Bouquets', stockTracked: true, stock: 18, reorder: 10, palette: 'Dusty Rose & Lavender', image: '/assets/images/flora-asset-01.jpg' },
  { slug: 'vintage-peony-eucalyptus-posy', name: 'Vintage Peony & Eucalyptus Posy', sku: 'FA-PEONYPOS', price: 2150, category: 'Flowers & Bouquets', stockTracked: true, stock: 12, reorder: 8, palette: 'Peony & Eucalyptus', image: '/assets/images/flora-asset-02.jpg' },
  { slug: 'rakhi-everlasting-bloom-set', name: 'Rakhi Everlasting Ceremonial Bloom Set', sku: 'FA-RAKHIBL', price: 2200, category: 'Flowers & Bouquets', stockTracked: true, stock: 9, reorder: 6, palette: 'Marigold & Saffron', image: '/assets/images/flora-asset-03.jpg' },
  { slug: 'pressed-wildflower-cards', name: 'Pressed Botanical Wildflower Cards (Set of 4)', sku: 'FA-PRESSEDW', price: 850, category: 'Handmade Cards', stockTracked: true, stock: 32, reorder: 12, palette: 'Wildflower Mix', image: '/assets/images/flora-asset-04.jpg' },
  { slug: 'botanical-wax-seal-kit', name: 'Botanical Wax Seal Ritual Kit', sku: 'FA-WAXSEAL', price: 1150, category: 'Handmade Cards', stockTracked: true, stock: 15, reorder: 8, palette: 'Heritage Gold', image: '/assets/images/flora-asset-05.jpg' },
  { slug: 'gold-foil-pressed-stickers', name: 'Gold Foil Pressed Botanical Stickers (Sheet of 12)', sku: 'FA-FOILSTK', price: 450, category: 'Handmade Cards', stockTracked: true, stock: 40, reorder: 15, palette: 'Gold Leaf', image: '/assets/images/flora-asset-06.jpg' },
  { slug: 'desk-bloom-ceramic-pot', name: 'Desk Bloom in Ceramic Pot', sku: 'FA-DESKPOT', price: 1250, category: 'Charms & Vessels', stockTracked: true, stock: 14, reorder: 8, palette: 'Ceramic Cream', image: '/assets/images/flora-asset-07.jpg' },
  { slug: 'chenille-garden-mascot-charm', name: 'Chenille Garden Sunflower Mascot Charm', sku: 'FA-CHENCHAR', price: 650, category: 'Charms & Vessels', stockTracked: true, stock: 22, reorder: 10, palette: 'Sunflower Gold', image: '/assets/images/flora-asset-08.jpg' },
  { slug: 'heirloom-brass-snipping-shears', name: 'Heirloom Brass Snipping Shears', sku: 'FA-BRASSHE', price: 750, category: 'Charms & Vessels', stockTracked: true, stock: 18, reorder: 8, palette: 'Polished Brass', image: '/assets/images/flora-asset-09.jpg' },
  { slug: 'heirloom-keepsake-hamper', name: 'Heirloom Keepsake Wooden Hamper Box', sku: 'FA-KEEPHAM', price: 3450, category: 'Custom Gifts & Hampers', stockTracked: true, stock: 6, reorder: 4, palette: 'Walnut & Cream', image: '/assets/images/flora-asset-10.jpg' },
];

const FIXTURE_COLLECTIONS = [
  {
    slug: 'festival-collection',
    name: 'Festival Collection',
    description: 'Raksha Bandhan, Diwali and festive keepsakes.',
    occasion: 'Festive',
    productSlugs: ['rakhi-everlasting-bloom-set', 'gold-foil-pressed-stickers'],
  },
  {
    slug: 'quiet-anniversaries',
    name: 'Quiet Anniversaries & Romance',
    description: 'Soft palettes for tender milestones.',
    occasion: 'Anniversary',
    productSlugs: ['dusty-rose-lavender-posy', 'vintage-peony-eucalyptus-posy'],
  },
  {
    slug: 'desk-and-daily',
    name: 'Desk Blooms & Daily Rituals',
    description: 'Small handmade things for everyday desks.',
    occasion: 'Everyday',
    productSlugs: ['desk-bloom-ceramic-pot', 'botanical-wax-seal-kit', 'gold-foil-pressed-stickers'],
  },
];

const FIXTURE_CUSTOMERS = [
  { name: 'Demo Customer', email: 'customer@example.com', phone: '+91 98000 00000', fixture: true, password: 'demo1234' },
  { name: 'Aarav Mehta', email: 'aarav.mehta@example.com', phone: '+91 98200 12345', city: 'Mumbai', state: 'Maharashtra' },
  { name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+91 98111 23456', city: 'New Delhi', state: 'Delhi' },
  { name: 'Ananya Verma', email: 'ananya.verma@example.com', phone: '+91 98333 45678', city: 'Bangalore', state: 'Karnataka' },
  { name: 'Sneha Nair', email: 'sneha.nair@example.com', phone: '+91 98999 01234', city: 'Kochi', state: 'Kerala' },
];

// Order status mix across the canonical lifecycle, matching dashboard stages.
const FIXTURE_ORDERS = [
  { orderId: 'FA-0912', customerEmail: 'aarav.mehta@example.com', status: 'delivered', total: 1850, item: 'The Dusty Rose & Lavender Dream Posy', slug: 'dusty-rose-lavender-posy', daysAgo: 22 },
  { orderId: 'FA-1024', customerEmail: 'priya.sharma@example.com', status: 'in_production', total: 2700, item: 'The Dusty Rose & Lavender Dream Posy', slug: 'dusty-rose-lavender-posy', daysAgo: 5 },
  { orderId: 'FA-1045', customerEmail: 'ananya.verma@example.com', status: 'quality_check', total: 2150, item: 'Vintage Peony & Eucalyptus Posy', slug: 'vintage-peony-eucalyptus-posy', daysAgo: 3 },
  { orderId: 'FA-1047', customerEmail: 'sneha.nair@example.com', status: 'shipped', total: 2700, item: 'The Dusty Rose & Lavender Dream Posy', slug: 'dusty-rose-lavender-posy', daysAgo: 2 },
  { orderId: 'FA-1048', customerEmail: 'demo-fixture@flora-alchemy.demo', status: 'new', total: 2700, item: 'Heirloom Keepsake Wooden Hamper Box', slug: 'heirloom-keepsake-hamper', daysAgo: 0 },
];

export async function seedIfEmpty({ force = false } = {}) {
  // Phase 20.6 — the demo credentials below are a DEVELOPMENT convenience.
  // They must never be created in a database that is not unmistakably
  // disposable; a production database containing a quick-fill admin account is
  // exactly the risk this phase removes. Non-disposable targets skip the whole
  // seed (returning 0) instead of throwing, so a misconfigured boot still
  // starts the server — it just does not write anything.
  const dbClass = classifyDatabase();
  if (!dbClass.disposable && !dbClass.confirmed) {
    console.warn(
      `[seed] refusing to write fixtures — ${describeDatabase()}. ` +
      'Fixture data (including demo credentials) is only created in a disposable database.'
    );
    return 0;
  }

  const allowDemoCredentials = (() => {
    try {
      assertFixtureAccountsAllowed(process.env.MONGO_URI, 'seed demo fixture accounts');
      return true;
    } catch (err) {
      console.warn(`[seed] ${err.message.split('\n')[0]}`);
      return false;
    }
  })();

  let created = 0;

  // Products + inventory
  for (const p of FIXTURE_PRODUCTS) {
    const exists = await Product.findOne({ slug: p.slug });
    if (!exists || force) {
      await Product.updateOne(
        { slug: p.slug },
        {
          $set: {
            name: p.name,
            sku: p.sku,
            price: p.price,
            category: p.category,
            stockTracked: p.stockTracked,
            palette: p.palette || '',
            image: p.image,
            visibility: 'Visible',
            isFixture: true,
          },
        },
        { upsert: true }
      );
      created += 1;
    }
    const invExists = await Inventory.findOne({ productSlug: p.slug });
    if (!invExists) {
      await Inventory.create({
        productSlug: p.slug,
        sku: p.sku,
        productName: p.name,
        currentStock: p.stock,
        reorderLevel: p.reorder,
        isFixture: true,
      });
    }
  }

  // Collections
  for (const c of FIXTURE_COLLECTIONS) {
    const exists = await Collection.findOne({ slug: c.slug });
    if (!exists || force) {
      await Collection.updateOne({ slug: c.slug }, { $set: { ...c, visibility: 'Visible', isFixture: true } }, { upsert: true });
      created += 1;
    }
  }

  // Settings
  const settings = await Settings.findOne({ key: 'default' });
  if (!settings) {
    await Settings.create({ key: 'default' });
    created += 1;
  }

  // Customers + their auth Users (demo customer keeps its quick-fill password)
  for (const c of FIXTURE_CUSTOMERS) {
    let customer = await Customer.findOne({ email: c.email });
    if (!customer) {
      customer = await Customer.create({
        name: c.name,
        email: c.email,
        phone: c.phone || '',
        status: 'Active',
        city: c.city || '',
        state: c.state || '',
        isFixture: !!c.fixture,
      });
      created += 1;
    }
    if (c.password && allowDemoCredentials) {
      // demo customer fixture: real hashed password for the dev quick-fill
      const user = await User.findOne({ email: c.email });
      if (!user) {
        const passwordHash = await bcrypt.hash(c.password, 12);
        await User.create({
          email: c.email,
          passwordHash,
          role: 'customer',
          name: c.name,
          customerId: customer._id,
          isFixture: true,
        });
        created += 1;
      }
    }
  }

  // Handler admin user (dev quick-fill on /admin/login)
  const admin = allowDemoCredentials
    ? await User.findOne({ email: 'handler.admin@flora-alchemy.demo' })
    : null;
  if (!admin && allowDemoCredentials) {
    const passwordHash = await bcrypt.hash('handler1234', 12);
    await User.create({
      email: 'handler.admin@flora-alchemy.demo',
      passwordHash,
      role: 'admin',
      name: 'Handler Admin',
      isFixture: true,
    });
    created += 1;
  }

  // Sample orders (fixtures; stock records already reflect these sales).
  // Every order must reference a real Customer doc, so a lightweight fixture
  // customer is created on the fly when one does not exist yet.
  for (const o of FIXTURE_ORDERS) {
    const exists = await Order.findOne({ orderId: o.orderId });
    if (exists && !force) continue;

    let customer = await Customer.findOne({ email: o.customerEmail });
    if (!customer) {
      customer = await Customer.create({
        name: 'Sample Customer',
        email: o.customerEmail,
        phone: '',
        status: 'Active',
        isFixture: true,
      });
    }

    const createdAt = new Date(Date.now() - o.daysAgo * 86400000);
    const product = await Product.findOne({ slug: o.slug }).lean();
    const price = product ? product.price : o.total;
    const quantity = Math.max(1, Math.round(o.total / price));
    await Order.updateOne(
      { orderId: o.orderId },
      {
        $set: {
          customerId: customer._id,
          customerName: customer.name,
          customerEmail: customer.email,
          items: [
            {
              productSlug: o.slug,
              name: product ? product.name : o.item,
              price,
              quantity,
              isCatalogue: true,
              image: product ? product.image : '',
            },
          ],
          subtotal: price * quantity,
          shipping: 0,
          total: price * quantity,
          paymentStatus: 'Sample',
          paymentMethod: 'Sample',
          orderStatus: o.status,
          statusHistory: [{ status: o.status, note: 'Fixture order' }],
          isFixture: true,
          createdAt,
        },
      },
      { upsert: true }
    );
    created += 1;
  }

  return created;
}

/**
 * CLI entry point (`npm run seed`).
 *
 * This is the path a developer triggers by hand, so it FAILS CLOSED and exits
 * non-zero when the configured database is not disposable — an explicit
 * refusal is the only safe answer for an unattended `npm run seed` that would
 * otherwise write fixtures (and demo credentials) into a live database.
 */
async function main() {
  try {
    assertSafeDatabase(process.env.MONGO_URI, 'seed fixture data');
    await connectDB();
    console.log(`[seed] target — ${describeDatabase()}`);
    const created = await seedIfEmpty();
    console.log(`[seed] complete — ${created} fixture records created.`);
    await mongoose.disconnect();
  } catch (err) {
    console.error('[seed] failed:', err.message);
    process.exit(1);
  }
}

// Allow `node seed/seed.js` and import from server.js
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  main();
}
