// BLINKDEAL detector — runs on GitHub Actions.
//
// Each scheduled run does one honest attempt to read Myntra's gold-coin
// listing (with a few retries), reports any BLINKDEAL deal to the blinkdeal
// Worker (blinkdeal.paype.co), and — if a deal is live — keeps polling for a
// few minutes to catch when it clears. The Worker owns subscribers + SMS
// fan-out and only notifies on transitions.
//
// IMPORTANT: Myntra soft-blocks datacenter IPs (GitHub runners included) by
// serving a ~480-byte "Site Maintenance" stub to a large fraction of requests.
// A blocked run is an EXPECTED external condition, NOT a code failure — so we
// exit 0 and never spam failure emails. We only exit non-zero for real config
// errors (missing/invalid REPORT_KEY).
//
// Zero npm dependencies: Node built-in fetch only.
import { extractProducts } from './extractProducts.js';

const REPORT_URL = (process.env.REPORT_URL || 'https://blinkdeal.paype.co').replace(/\/$/, '');
const REPORT_KEY = process.env.REPORT_KEY || '';
const MYNTRA_URL = process.env.MYNTRA_URL || 'https://www.myntra.com/gold-coin';
const KEYWORDS = (process.env.COUPON_KEYWORDS || 'blinkdeal')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '2', 10);

// Attempts per job. Myntra's block is per-IP deterministic (verified: curl_cffi
// with a perfect Chrome fingerprint got the same block on the same runner IP),
// so retrying the SAME runner rarely helps — IP diversity is what matters. The
// workflow gets that by fanning out across parallel runners (different IPs), so
// each job just needs 1-2 quick tries.
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || '2', 10);
const ATTEMPT_DELAY_MS = parseInt(process.env.ATTEMPT_DELAY_MS || '3000', 10);

const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function headers(ua) {
  return {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'no-cache',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One pass over the listing pages. Returns [] if blocked/empty.
async function scanOnce(ua) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = MYNTRA_URL.includes('?') ? '&' : '?';
    const url = page === 1 ? MYNTRA_URL : `${MYNTRA_URL}${sep}p=${page}`;
    let html = '';
    try {
      const res = await fetch(url, { headers: headers(ua), redirect: 'follow', signal: AbortSignal.timeout(20000) });
      html = await res.text();
    } catch {
      break;
    }
    const products = extractProducts(html);
    if (!products.length) break;
    let added = 0;
    for (const p of products) {
      const id = String(p.productId ?? p.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id); all.push(p); added++;
    }
    if (!added) break;
  }
  return all;
}

// Retry the scan until we get real products or run out of attempts.
async function scanWithRetry(maxAttempts) {
  for (let i = 0; i < maxAttempts; i++) {
    const ua = UAS[i % UAS.length];
    const products = await scanOnce(ua);
    if (products.length) return { products, attempts: i + 1 };
    if (i < maxAttempts - 1) await sleep(ATTEMPT_DELAY_MS);
  }
  return { products: [], attempts: maxAttempts };
}

function detect(products) {
  const deals = [];
  for (const p of products) {
    const cd = p.couponData || {};
    // Match against the ENTIRE couponData JSON — robust to Myntra's structure
    // changes. The coupon code (e.g. BLINKDEAL6) lives in couponData.tagLink
    // ("Coupons:BLINKDEAL6_…") and couponData.couponDescription.couponCode,
    // and couponDescription flipped from a string to a nested object.
    const title = p.product || p.productName || '';
    const hay = `${title} ${JSON.stringify(cd)}`.toLowerCase();
    const matched = KEYWORDS.find((k) => hay.includes(k));
    if (!matched) continue;

    // Build a human-readable coupon label for the alert/log.
    const desc = cd.couponDescription;
    let coupon = '';
    if (desc && typeof desc === 'object') {
      coupon = [desc.couponCode, desc.bestPrice ? `best ₹${desc.bestPrice}` : '']
        .filter(Boolean).join(' ');
    } else if (typeof desc === 'string') {
      coupon = desc;
    }
    if (!coupon) coupon = matched.toUpperCase();

    const landing = String(p.landingPageUrl || '').replace(/^\//, '');
    deals.push({
      id: String(p.productId ?? ''),
      title,
      coupon: coupon.slice(0, 160),
      url: landing ? `https://www.myntra.com/${landing}` : 'https://www.myntra.com/gold-coin',
    });
  }
  return deals;
}

async function report(deals, productsSeen) {
  const res = await fetch(`${REPORT_URL}/api/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': REPORT_KEY },
    body: JSON.stringify({ productsSeen, deals }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('REPORT_KEY rejected by worker (401) — check the Actions secret');
  return { status: res.status, ...body };
}

async function main() {
  if (!REPORT_KEY) {
    console.error('REPORT_KEY missing — set the Actions secret.');
    process.exit(1); // genuine config error → worth surfacing
  }

  const started = new Date().toISOString();
  const { products, attempts } = await scanWithRetry(MAX_ATTEMPTS);

  if (products.length === 0) {
    // Myntra served the maintenance stub to this runner's IP on every attempt.
    // Expected for datacenter IPs — NOT a failure. Exit 0 so no email is sent.
    console.log(`[${started}] blocked after ${attempts} attempts (Myntra maintenance stub to this runner IP) — skipping. Not a failure.`);
    process.exit(0);
  }

  // Got through. Report current state — the Worker handles start/stop
  // transitions + subscriber SMS. Frequent triggers (every 5 min active) catch
  // both the deal appearing and clearing; one of the parallel runners getting
  // through per trigger is enough.
  const deals = detect(products);
  try {
    const r = await report(deals, products.length);
    const note = deals.length
      ? ` 🟢 DEAL x${deals.length} (worker: new=${r.newCount}, notified=${r.notifiedCount})`
      : r.cleared ? ' (worker: cleared, stop sent)' : '';
    console.log(`[${started}] products=${products.length} attempts=${attempts} deals=${deals.length}${note}`);
  } catch (e) {
    if (/REPORT_KEY rejected/.test(e.message)) {
      console.error(e.message);
      process.exit(1);
    }
    console.log(`[${started}] report error (transient): ${e.message}`);
  }

  process.exit(0);
}

main();
