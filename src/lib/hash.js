// Fast non-crypto hashes: murmur3 (32-bit), fnv1a, and a [0,1) bucket helper
export function murmur3(key, seed = 0) {
  const s = String(key); let h = seed >>> 0; const n = s.length; let i = 0;
  const bytes = new TextEncoder().encode(s); const len = bytes.length;
  for (; i + 4 <= len; i += 4) { let k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24); k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593); h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0; }
  let k = 0; switch (len & 3) { case 3: k ^= bytes[i + 2] << 16; case 2: k ^= bytes[i + 1] << 8; case 1: k ^= bytes[i]; k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593); h ^= k; }
  h ^= len; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; void n; return h >>> 0;
}
export function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
/** Stable bucket in [0, 1) for (salt, key) — used for percentage rollouts and sticky routing. */
export const bucket = (salt, key) => murmur3(`${salt}:${key}`) / 4294967296;
