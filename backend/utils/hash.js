import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Stable sha256 of a file on disk. Used as the canonical asset hash so the
 * product projection can report whether a stored model changed without re-reading
 * the whole buffer into process memory.
 */
export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(path.resolve(filePath));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
