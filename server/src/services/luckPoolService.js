/**
 * luckPoolService.js
 *
 * Fetches wallet stats from LuckPool's free public API.
 * No API key required.
 *
 * Endpoints used:
 *   GET https://luckpool.net/verus/api/miner/{wallet}    → unpaid balance + stats
 *   GET https://luckpool.net/verus/api/payments/{wallet} → payment history
 */

const WALLET = process.env.WALLET_ADDRESS || 'RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ';

// LuckPool exposes the same API on both the regional host and the main site.
// Try ap. first (closest to Asia/India), fall back to the main domain.
// NOTE: No /api/ in the path — correct format is /verus/miner/{wallet}
const BASES = [
  'https://luckpool.net/verus',
  'https://ap.luckpool.net/verus',
];

async function fetchFromPool(path) {
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}${path}`);
      if (res.status === 404) {
        // Wallet not yet registered on pool — no mining history yet.
        console.warn(`[LUCKPOOL] 404 on ${base}${path} — wallet not yet registered or no shares.`);
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[LUCKPOOL] ${base}${path} failed: ${err.message}`);
    }
  }
  return null; // all endpoints failed
}

/**
 * Fetch current unpaid balance from LuckPool.
 * Returns the balance in VRSC as a float, or null on failure / unregistered wallet.
 */
async function getUnpaidBalance() {
  const data = await fetchFromPool(`/miner/${WALLET}`);
  if (!data) return null;

  // LuckPool returns amounts in satoshi-like units (×10^8). Divide to get VRSC.
  // Field name varies by API version: balance | unpaid | immature
  const raw = data?.balance ?? data?.unpaid ?? data?.immature ?? null;
  if (raw === null) {
    console.warn('[LUCKPOOL] Miner data received but no balance field:', JSON.stringify(data).slice(0, 200));
    return null;
  }
  return parseFloat((Number(raw) / 1e8).toFixed(8));
}

/**
 * Fetch payments received AFTER a given timestamp (ms).
 * Returns total VRSC paid since that timestamp.
 */
async function getPaymentsSince(sinceMs) {
  try {
    const res  = await fetch(`${BASE}/payments/${WALLET}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const payments = Array.isArray(data) ? data : (data?.payments ?? []);
    let total = 0;
    for (const p of payments) {
      // LuckPool timestamps are in seconds; amounts in satoshi-like units.
      const ts     = (p.timestamp ?? p.time ?? 0) * 1000; // → ms
      const amount = parseFloat((Number(p.amount ?? p.value ?? 0) / 1e8).toFixed(8));
      if (ts > sinceMs) total += amount;
    }
    return parseFloat(total.toFixed(8));
  } catch (err) {
    console.error('[LUCKPOOL] Failed to fetch payments:', err.message);
    return 0;
  }
}

module.exports = { getUnpaidBalance, getPaymentsSince };
