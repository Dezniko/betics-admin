// Ethereum helpers with no dependencies: Keccak-256 (for EIP-55 address
// checksums), address validation and TICS unit formatting.
const MASK = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
// Rotation offsets r[x][y].
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const rotl = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    const C = [0, 1, 2, 3, 4].map(x => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D;
    }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y]);
    A[0] ^= RC[round];
  }
}

// Keccak-256 (the Ethereum hash, not NIST SHA3-256). Returns lowercase hex.
export function keccak256(bytes) {
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const rate = 136, padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input); padded[input.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  let out = '';
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((A[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  return out;
}

// EIP-55 mixed-case checksum form of an address.
export function toChecksumAddress(address) {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = keccak256(lower);
  return '0x' + [...lower].map((c, i) => parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c).join('');
}

// Lowercase 0x address, or null. All-lowercase and all-uppercase are accepted;
// mixed case must carry a correct EIP-55 checksum (catches typos).
export function normAddress(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  const body = v.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return v.toLowerCase();
  return toChecksumAddress(v) === v ? v.toLowerCase() : null;
}

export const isTxHash = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);

// 0.01 TICS units -> '1,234.50 TICS'.
export function formatTics(units) {
  const n = Number(units) || 0, sign = n < 0 ? '-' : '', abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')} TICS`;
}

export const explorerBase = chainId => Number(chainId) === 11155111 ? 'https://sepolia.etherscan.io' : 'https://etherscan.io';
