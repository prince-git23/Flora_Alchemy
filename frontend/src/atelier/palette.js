/**
 * THE ATELIER — shared vocabulary between the 3D workshop and the shop.
 *
 * This module is deliberately dependency-free and tiny: it is imported by both
 * the lazy WebGL chunk and the HTML overlays (and by the static fallback), so it
 * must never pull three.js into the entry bundle.
 *
 * The ids here mirror the Custom Gift Studio (`CustomGiftsPage.jsx`) exactly,
 * because a composition chosen in the atelier is not a separate product — it is
 * the SAME gift, pre-filled, and the server remains authoritative for its price.
 */

/** Warm, paper-and-brass palette shared by the scene, the overlay and the fallback. */
export const ATELIER = Object.freeze({
  paper: '#f7f1e6',
  paperDeep: '#efe6d6',
  ink: '#241a12',
  brass: '#b89746',
  brassDark: '#8a6d2f',
  oak: '#8a6a4a',
  oakDark: '#5a4636',
  sage: '#5b6d54',
  terracotta: '#964735',
  blush: '#c98e87',
  lavender: '#9a7b9b',
  cream: '#e8dec8',
  lamp: '#ffd9a0',
});

/** Colour palettes — the SAME four the studio sells. */
export const PALETTES = Object.freeze([
  { id: 'mauve', name: 'Dusty Rose & Lavender', primary: '#c98e87', secondary: '#9a7b9b', foliage: '#7c8b6d' },
  { id: 'sage', name: 'Sage Leaf & Forest Olive', primary: '#82927c', secondary: '#495b42', foliage: '#5f7355' },
  { id: 'terracotta', name: 'Terracotta & Burnished Ochre', primary: '#ba6d5b', secondary: '#dfb39d', foliage: '#7d8a63' },
  { id: 'cream', name: 'Parchment Cream & Gold Leaf', primary: '#e8dec8', secondary: '#cca856', foliage: '#8a9270' },
]);

/** Wax seals — the same three, with the scene's material values alongside. */
export const SEALS = Object.freeze([
  { id: 'terracotta', name: 'Terracotta Clay', hex: '#964735', roughness: 0.52, sheen: 0.18 },
  { id: 'sage', name: 'Dried Sage', hex: '#5b6d54', roughness: 0.5, sheen: 0.16 },
  { id: 'gold', name: 'Burnished Antique Gold', hex: '#b89746', roughness: 0.32, sheen: 0.42, metallic: 0.55 },
]);

/** Ribbons — the studio's three, with the look each one needs in 3D. */
export const RIBBONS = Object.freeze([
  { id: 'frayed-silk', name: 'Frayed Edge Plant-Dyed Silk', hex: '#b98f7d', roughness: 0.82, sheen: 0.12 },
  { id: 'velvet-cord', name: 'French Olive Velvet Cord', hex: '#5f6b46', roughness: 0.42, sheen: 0.5 },
  { id: 'deckled-twine', name: 'Natural Cotton Jute Twine', hex: '#c9b591', roughness: 0.95, sheen: 0.04 },
]);

/** Keepsake bases — the three the studio offers, with the atelier's prop scale. */
export const BASES = Object.freeze([
  { id: 'keepsake-posy', name: 'Handcrafted Everlasting Posy', hint: 'deckled mulberry bark washi, raw silk' },
  { id: 'heirloom-box', name: 'Solid Pine Sliding Hamper Box', hint: 'finished pine casket, brass shears' },
  { id: 'ceramic-pot', name: 'Artisan Speckled Ceramic Vessel', hint: 'hand-thrown stoneware, moss bedding' },
]);

export const LETTERS = Object.freeze('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

/** Resolve an id against a list, falling back to the first entry. */
export function pick(list, id) {
  return list.find((entry) => entry.id === id) || list[0];
}

/**
 * The URL the atelier hands to the studio. Only ids the studio knows are sent,
 * so a hand-edited query string cannot invent a product or a price.
 */
export function studioHref({ paletteId, sealId, ribbonId, baseId, monogram }) {
  const params = new URLSearchParams();
  params.set('base', pick(BASES, baseId).id);
  params.set('palette', pick(PALETTES, paletteId).id);
  params.set('seal', pick(SEALS, sealId).id);
  params.set('ribbon', pick(RIBBONS, ribbonId).id);
  const letters = String(monogram || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  if (letters) params.set('monogram', letters);
  return `/custom-gifts?${params.toString()}`;
}
