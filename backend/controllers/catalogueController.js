import crypto from 'node:crypto';
import Product from '../models/Product.js';
import { cached } from '../utils/publicCache.js';
import { attachAvailability } from './productController.js';
import { activeShopMap, isPubliclyDiscoverable, publicProduct } from '../utils/publicShop.js';

/**
 * PUBLIC CATALOGUE — the storefront's featured / hero projection.
 *
 * `?featured=true` and `?hero=true` are the SAME server-side set: products an
 * administrator explicitly promoted with `hero: true`, ordered by `heroOrder`.
 * There is no separate hard-coded list on the client, so adding or reordering a
 * hero item in the portal changes both the pinned hero and Beloved Pieces.
 *
 * The response is deliberately narrow. It carries only public catalogue fields
 * (plus the optional studio media fields) and the canonical `{slug,displayName}`
 * shop attribution; `workspaceId` and internal audit flags never leave here.
 *
 * ETag: computed from the FINAL public payload, including live stock attached
 * after the 30s metadata cache. A stock change therefore changes the validator
 * instead of serving a stale 304. `Cache-Control` is bounded and revalidated;
 * the bytes are never immutable because price and availability can change.
 */

const PUBLIC_FIELDS = [
  'slug',
  'name',
  'sku',
  'price',
  'category',
  'description',
  'image',
  'images',
  'palette',
  'ribbon',
  'occasion',
  'stockTracked',
  'stock',
  'reorderLevel',
  'hero',
  'heroOrder',
  'tagline',
  'heroCutout',
  'model',
  'turntable',
  'accent',
  'createdAt',
  'updatedAt',
];

function publicCatalogueItem(product, shop) {
  const base = publicProduct(product, shop);
  const out = { id: base.slug };
  PUBLIC_FIELDS.forEach((field) => {
    if (base[field] !== undefined) out[field] = base[field];
  });
  out.images = Array.isArray(out.images) ? out.images.filter(Boolean) : [];
  out.turntable = Array.isArray(out.turntable) ? out.turntable.filter(Boolean) : [];
  return out;
}

export async function listCatalogue(req, res, next) {
  try {
    const featured = req.query.featured === 'true';
    const hero = req.query.hero === 'true';
    const filters = { visibility: 'Visible' };
    if (featured || hero) filters.hero = true;

    /* Keep the response order stable and independent of insertion order. */
    const sort = (featured || hero)
      ? { heroOrder: 1, createdAt: 1 }
      : { createdAt: 1 };
    /* Prefix `products:` so the existing product-write invalidation covers this
       projection too (create/update/delete/visibility all clear that prefix). */
    const cacheKey = `products:catalogue:${featured ? 'featured' : ''}:${hero ? 'hero' : ''}`;
    const rows = await cached(
      cacheKey,
      () => Product.find(filters).sort(sort).limit(featured || hero ? 50 : 500).lean(),
      Product
    );

    await attachAvailability(rows);
    const shopMap = await activeShopMap(rows.map((row) => row && row.workspaceId));
    const items = rows
      .filter((row) => isPubliclyDiscoverable(row, shopMap))
      .map((row) =>
        publicCatalogueItem(
          row,
          row.workspaceId ? shopMap.get(String(row.workspaceId)) || null : null
        )
      )
      .map((item, index) => ({ ...item, heroOrder: Number(item.heroOrder) || index }));

    const body = JSON.stringify({ success: true, count: items.length, items });
    const etag = `W/"catalogue-${crypto.createHash('sha1').update(body).digest('hex')}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=180');
    res.set('Vary', 'Origin');
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    return res.type('application/json').send(body);
  } catch (err) {
    return next(err);
  }
}
