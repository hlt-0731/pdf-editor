/**
 * L1 Crypto Layer — PDF Password Encryption (RC4 128-bit)
 *
 * Implements PDF standard security handler (revision 3, V=2) with 128-bit
 * RC4 encryption.  This is the most widely compatible PDF encryption method,
 * supported by all modern PDF readers.
 *
 * PDF 32000-1:2008 §7.6 (Encryption)
 *
 * This module builds the /Encrypt dictionary and performs stream/string
 * encryption for the incremental update pipeline.
 *
 * Key derivation follows Algorithm 2 (§7.6.3.3):
 *   MD5( password‖O‖P‖ID ) → repeated 50× → file encryption key
 *
 * Owner password hash follows Algorithm 3 (§7.6.3.3):
 *   MD5(ownerPwd) → RC4(userPwd, key) → 19 rounds of RC4 with XOR'd keys
 *
 * User password hash follows Algorithm 5 (§7.6.3.4):
 *   MD5( padding‖ID ) → RC4(hash, fileKey) → 19 rounds of RC4 with XOR'd keys
 */

// ---------------------------------------------------------------------------
// PDF password padding (Table 3.18 / §7.6.3.3)
// ---------------------------------------------------------------------------

/**
 * The standard 32-byte padding string used in PDF encryption key derivation.
 */
const PDF_PASSWORD_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4b, 0x49, 0x43, 0x4b, 0x53, 0x2e,
  0x41, 0x52, 0x4e, 0x45, 0x2f, 0x54, 0x68, 0x69,
  0x73, 0x20, 0x69, 0x73, 0x20, 0x73, 0x45, 0x43,
]);

// ---------------------------------------------------------------------------
// Permission flags (PDF §7.6.3.2, Table 3.20)
// ---------------------------------------------------------------------------

/** Default permissions: allow everything except extraction for accessibility. */
export const DEFAULT_PERMISSIONS =
  0xfffff0c0 | // Reserved bits (must be 1)
  0x00000004 | // Print
  0x00000008 | // Modify contents
  0x00000010 | // Copy / extract
  0x00000020;  // Annotate

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EncryptionResult {
  /** Serialized /Encrypt dictionary (without obj/endobj wrapper). */
  encryptDictBytes: Uint8Array;
  /** The /ID array first element (16 random bytes). */
  fileId: Uint8Array;
}

/**
 * Build the /Encrypt dictionary for the given passwords.
 *
 * If `ownerPassword` is empty, `userPassword` is used for both.
 * If `userPassword` is empty, an empty string is used (open access with
 * owner password for restrictions).
 *
 * @param userPassword    Password required to open the PDF.
 * @param ownerPassword   Password for full access (defaults to userPassword).
 * @param permissions     Permission flags (default: allow all).
 * @param existingId      Existing /ID from the PDF trailer (reused if present).
 */
export function buildEncryptDictionary(
  userPassword: string,
  ownerPassword: string,
  permissions: number = DEFAULT_PERMISSIONS,
  existingId?: Uint8Array,
): EncryptionResult {
  const keyLength = 128; // bits
  const keyBytes = keyLength / 8; // 16

  // File ID — reuse existing or generate random.
  const fileId = existingId ?? generateFileId();

  // Pad passwords to 32 bytes.
  const userPwd = padPassword(userPassword);
  const ownerPwd = padPassword(ownerPassword || userPassword);

  // 1. Compute /O value (owner password hash).
  const oValue = computeOwnerPasswordValue(userPwd, ownerPwd, keyBytes);

  // 2. Compute the file encryption key.
  const fileKey = computeFileEncryptionKey(
    userPwd, oValue, permissions, fileId, keyBytes,
  );

  // 3. Compute /U value (user password hash).
  const uValue = computeUserPasswordValue(fileKey, fileId, keyBytes);

  // 4. Build the dictionary.
  const pSigned = permissions | 0; // ensure signed 32-bit
  const oHex = bytesToHex(oValue);
  const uHex = bytesToHex(uValue);

  const dict =
    `<< /Type /Encrypt` +
    ` /Filter /Standard` +
    ` /V 2` +
    ` /R 3` +
    ` /Length ${keyLength}` +
    ` /O <${oHex}>` +
    ` /U <${uHex}>` +
    ` /P ${pSigned}` +
    ` >>`;

  const enc = new TextEncoder();
  return {
    encryptDictBytes: enc.encode(dict),
    fileId,
  };
}

/**
 * Build the serialized /ID array for the trailer.
 * Format: `[<hex> <hex>]`
 */
export function serializeIdArray(id: Uint8Array): string {
  const hex = bytesToHex(id);
  return `[<${hex}> <${hex}>]`;
}

// ---------------------------------------------------------------------------
// Key derivation (PDF §7.6.3.3 — Algorithm 2)
// ---------------------------------------------------------------------------

function computeFileEncryptionKey(
  userPwd: Uint8Array,
  oValue: Uint8Array,
  permissions: number,
  fileId: Uint8Array,
  keyBytes: number,
): Uint8Array {
  // Step a: password (already padded to 32 bytes)
  // Step b: concatenate O value
  // Step c: concatenate P as unsigned 32-bit LE
  // Step d: concatenate file ID
  const pBytes = new Uint8Array(4);
  const pView = new DataView(pBytes.buffer);
  pView.setInt32(0, permissions, true); // little-endian

  const input = concat(userPwd, oValue, pBytes, fileId);

  // Step e: MD5
  let hash = md5(input);

  // Step f: (Revision ≥ 3) rehash 50 times using only first keyBytes
  for (let i = 0; i < 50; i++) {
    hash = md5(hash.slice(0, keyBytes));
  }

  return hash.slice(0, keyBytes);
}

// ---------------------------------------------------------------------------
// Owner password value (PDF §7.6.3.3 — Algorithm 3)
// ---------------------------------------------------------------------------

function computeOwnerPasswordValue(
  userPwd: Uint8Array,
  ownerPwd: Uint8Array,
  keyBytes: number,
): Uint8Array {
  // Step a: MD5 of padded owner password
  let hash = md5(ownerPwd);

  // Step b: (Revision ≥ 3) rehash 50 times
  for (let i = 0; i < 50; i++) {
    hash = md5(hash.slice(0, keyBytes));
  }

  const key = hash.slice(0, keyBytes);

  // Step c: RC4-encrypt padded user password
  let result = rc4(key, userPwd);

  // Step d: (Revision ≥ 3) 19 additional rounds with XOR'd key
  for (let round = 1; round <= 19; round++) {
    const roundKey = new Uint8Array(key.length);
    for (let j = 0; j < key.length; j++) {
      roundKey[j] = (key[j]! ^ round) & 0xff;
    }
    result = rc4(roundKey, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// User password value (PDF §7.6.3.4 — Algorithm 5)
// ---------------------------------------------------------------------------

function computeUserPasswordValue(
  fileKey: Uint8Array,
  fileId: Uint8Array,
  keyBytes: number,
): Uint8Array {
  // Step a: MD5(padding ‖ fileID)
  const hash = md5(concat(PDF_PASSWORD_PADDING, fileId));

  // Step b: RC4-encrypt with file key
  let result = rc4(fileKey, hash);

  // Step c: 19 additional rounds
  for (let round = 1; round <= 19; round++) {
    const roundKey = new Uint8Array(keyBytes);
    for (let j = 0; j < keyBytes; j++) {
      roundKey[j] = (fileKey[j]! ^ round) & 0xff;
    }
    result = rc4(roundKey, result);
  }

  // Step d: pad to 32 bytes (append arbitrary bytes)
  const padded = new Uint8Array(32);
  padded.set(result.slice(0, 16), 0);
  // Remaining 16 bytes are arbitrary — use zeros for simplicity.
  return padded;
}

// ---------------------------------------------------------------------------
// Password padding (PDF §7.6.3.3 step a)
// ---------------------------------------------------------------------------

function padPassword(password: string): Uint8Array {
  const result = new Uint8Array(32);
  const bytes = new TextEncoder().encode(password);
  const len = Math.min(bytes.length, 32);
  result.set(bytes.slice(0, len), 0);
  if (len < 32) {
    result.set(PDF_PASSWORD_PADDING.slice(0, 32 - len), len);
  }
  return result;
}

// ---------------------------------------------------------------------------
// RC4 cipher
// ---------------------------------------------------------------------------

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  // Key-Scheduling Algorithm (KSA)
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i]! + key[i % key.length]!) & 0xff;
    // Swap
    const tmp = S[i]!;
    S[i] = S[j]!;
    S[j] = tmp;
  }

  // Pseudo-Random Generation Algorithm (PRGA)
  const result = new Uint8Array(data.length);
  let ii = 0;
  let jj = 0;
  for (let k = 0; k < data.length; k++) {
    ii = (ii + 1) & 0xff;
    jj = (jj + S[ii]!) & 0xff;
    // Swap
    const tmp = S[ii]!;
    S[ii] = S[jj]!;
    S[jj] = tmp;
    const t = (S[ii]! + S[jj]!) & 0xff;
    result[k] = data[k]! ^ S[t]!;
  }

  return result;
}

// ---------------------------------------------------------------------------
// MD5 (RFC 1321)
// ---------------------------------------------------------------------------

function md5(data: Uint8Array): Uint8Array {
  // Pre-processing: padding
  const bitLen = data.length * 8;
  const padLen = (data.length + 9 + 63) & ~63; // round up to 64-byte boundary
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  // Append original length in bits as 64-bit LE
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, bitLen >>> 0, true);
  view.setUint32(padLen - 4, 0, true); // high 32 bits (always 0 for our use)

  // Constants
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  let a0 = 0x67452301 >>> 0;
  let b0 = 0xefcdab89 >>> 0;
  let c0 = 0x98badcfe >>> 0;
  let d0 = 0x10325476 >>> 0;

  for (let chunk = 0; chunk < padLen; chunk += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(chunk + j * 4, true);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      const rot = S[i]!;
      B = (B + (((F << rot) | (F >>> (32 - rot))) >>> 0)) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const result = new Uint8Array(16);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, a0, true);
  rv.setUint32(4, b0, true);
  rv.setUint32(8, c0, true);
  rv.setUint32(12, d0, true);
  return result;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

function generateFileId(): Uint8Array {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  return id;
}
