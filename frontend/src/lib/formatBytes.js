/**
 * PHASE 3 — one byte formatter for every upload surface.
 *
 * Review media and custom-request reference images both report file size to the
 * customer, so the human-readable conversion lives here rather than being
 * reimplemented per form. Never rounds up into a lie: 1,048,575 bytes reads as
 * "1024 KB", not "1.0 MB".
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
