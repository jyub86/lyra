// ULID — 128-bit lexicographically sortable id.
// 48-bit millisecond timestamp + 80-bit randomness, Crockford base32 (26 chars).
// Inlined to avoid an external dependency (design §15: 의존성 최소화).

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I, L, O, U)
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now, len) {
  let str = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    str = ENCODING[mod] + str;
    now = (now - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < len; i++) {
    str += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return str;
}

// Monotonic-ish within a single process tick is not required here; a fresh
// random suffix per call is sufficient for our local single-writer use.
export function ulid(seedTime = Date.now()) {
  return encodeTime(seedTime, TIME_LEN) + encodeRandom(RANDOM_LEN);
}
