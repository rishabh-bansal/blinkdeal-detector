// BLINKDEAL detector — runs on a residential Pi (primary) or GitHub Actions
// (fallback). Each run reads Myntra's gold-coin listing, reports any BLINKDEAL
// deal to the blinkdeal Worker (blinkdeal.paype.co), which owns subscribers +
// SMS fan-out and only notifies on transitions.
//
// Design notes:
//   - Myntra soft-blocks datacenter IPs by serving a ~480-byte "Site Maintenance"
//     stub. That is an EXPECTED external condition (exit 0, no failure email).
//   - We distinguish that verified block from genuine failures (HTTP errors,
//     network errors, schema/parse regressions) so real problems are visible and
//     a broken scan is NEVER mistaken for a "cleared deal".
//   - We only check "is BLINKDEAL live?", not the full catalogue. BLINKDEAL is a
//     category-wide coupon (attached to ~all gold coins), so the ~44 coins the
//     default listing inlines in one request are plenty to detect it.
//
// Zero npm dependencies: Node 18+ built-in fetch only.
import { extractProducts } from './extractProducts.js';

const SCAN_VERSION = '2.1.0'; // sent with every report so you can tell which code a reporter runs
const REPORT_URL = (process.env.REPORT_URL || 'https://blinkdeal.paype.co').replace(/\/$/, '');
const REPORT_KEY = process.env.REPORT_KEY || '';
const REPORTER_ID = (process.env.REPORTER_ID || 'unknown').slice(0, 20);
const MYNTRA_URL = process.env.MYNTRA_URL || 'https://www.myntra.com/gold-coin';
const KEYWORDS = (process.env.COUPON_KEYWORDS || 'blinkdeal')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw.trim())) {
    console.error(`Invalid ${name}=${JSON.stringify(raw)} (expected a plain integer ${min}–${max}).`);
    process.exit(1);
  }
  const n = parseInt(raw, 10);
  if (n < min || n > max) {
    console.error(`Invalid ${name}=${JSON.stringify(raw)} (out of range ${min}–${max}).`);
    process.exit(1);
  }
  return n;
}

const MAX_ATTEMPTS = intEnv('MAX_ATTEMPTS', 2, 1, 10);
const ATTEMPT_DELAY_MS = intEnv('ATTEMPT_DELAY_MS', 3000, 0, 60000);

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

function isMaintenanceStub(html) {
  // Verified Akamai block signature: a tiny page titled "Site Maintenance".
  return html.length < 4000 && /<title>\s*Site Maintenance\s*<\/title>/i.test(html);
}

// One fetch. Returns a TYPED outcome:
//   { outcome: 'ok', products }        got a real product array
//   { outcome: 'blocked' }             verified maintenance stub (expected)
//   { outcome: 'http-error', detail }  non-2xx / redirect
//   { outcome: 'network-error', detail }
//   { outcome: 'parse-error', detail } 200 OK but no products structure found
async function scanOnce(ua) {
  // The default listing inlines ~44 gold coins in one request — plenty to detect
  // a category-wide coupon like BLINKDEAL (it's attached to ~all coins). We don't
  // paginate: we're answering "is BLINKDEAL live?", not cataloguing all products.
  const url = MYNTRA_URL;
  let res;
  try {
    res = await fetch(url, {
      headers: headers(ua),
      redirect: 'manual', // don't silently follow redirects (or forward the key)
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { outcome: 'network-error', detail: String(e.message || e).split('\n')[0] };
  }
  if (res.status >= 300 && res.status < 400) return { outcome: 'http-error', detail: `redirect ${res.status}` };
  if (!res.ok) return { outcome: 'http-error', detail: `HTTP ${res.status}` };

  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { outcome: 'network-error', detail: `body read: ${e.message}` };
  }
  if (isMaintenanceStub(html)) return { outcome: 'blocked' };

  const products = extractProducts(html);
  if (products === null) {
    return { outcome: 'parse-error', detail: `no products array (len=${html.length})` };
  }
  return { outcome: 'ok', products };
}

// Retry only on transient outcomes (block/http/network). A parse-error is a
// schema regression — retrying the same page won't help, so surface it.
async function scanWithRetry() {
  let last;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const ua = UAS[i % UAS.length];
    last = await scanOnce(ua);
    last.attempts = i + 1;
    if (last.outcome === 'ok' || last.outcome === 'parse-error') return last;
    if (i < MAX_ATTEMPTS - 1) await sleep(ATTEMPT_DELAY_MS);
  }
  return last;
}

// Build a safe product URL: only accept an absolute landingPageUrl if it is
// https on a myntra.com host; otherwise treat it as a relative path. Never
// produce a link to an arbitrary external host.
export function safeMyntraUrl(landing) {
  const s = String(landing || '');
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol === 'https:' && /(^|\.)myntra\.com$/i.test(u.hostname)) return u.toString();
    } catch { /* fall through */ }
    return 'https://www.myntra.com/gold-coin';
  }
  return `https://www.myntra.com/${s.replace(/^\//, '')}`;
}

export function detect(products) {
  const deals = [];
  for (const p of products) {
    const id = String(p.productId ?? p.id ?? '').trim();
    if (!id) continue; // no stable id → can't dedup/report meaningfully

    // Match ONLY the coupon-bearing fields — never the product title. A coin
    // whose name happens to contain "BLINKDEAL" must not false-positive, and a
    // coupon in `offerText` must not be missed.
    const cd = p.couponData || {};
    const hay = `${JSON.stringify(cd)} ${p.offerText || ''}`.toLowerCase();
    const matched = KEYWORDS.find((k) => hay.includes(k));
    if (!matched) continue;

    const desc = cd.couponDescription;
    let coupon = '';
    if (desc && typeof desc === 'object') {
      coupon = [desc.couponCode, desc.bestPrice ? `best ₹${desc.bestPrice}` : '']
        .filter(Boolean).join(' ');
    } else if (typeof desc === 'string') {
      coupon = desc;
    }
    if (!coupon) coupon = matched.toUpperCase();

    deals.push({
      id,
      title: String(p.product || p.productName || '').slice(0, 200),
      coupon: coupon.slice(0, 160),
      url: safeMyntraUrl(p.landingPageUrl).slice(0, 500),
    });
  }
  return deals;
}

// Reliable report. Retries 429/5xx with backoff; treats 401/403 as fatal config
// errors; throws on any non-2xx so the caller can decide (an undelivered DEAL is
// fatal). Redirects disabled so the x-admin-key is never forwarded to another host.
async function report(body) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`${REPORT_URL}/api/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': REPORT_KEY },
        body: JSON.stringify({ ...body, reporter: REPORTER_ID, version: SCAN_VERSION }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      lastErr = new Error(`report network error: ${String(e.message || e).split('\n')[0]}`);
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      throw lastErr;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`REPORT_KEY rejected (${res.status}) — fatal config error`);
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`report failed ${res.status}`);
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      throw lastErr;
    }
    if (!res.ok) throw new Error(`report failed ${res.status}`);
    // A 2xx is not enough — validate the worker actually acknowledged with the
    // expected JSON shape. A stray 200 text/html (proxy/error page) is a failure.
    const ct = res.headers.get('content-type') || '';
    let ack;
    try {
      ack = ct.includes('application/json') ? await res.json() : JSON.parse(await res.text());
    } catch {
      throw new Error('report ack was not JSON');
    }
    if (!ack || typeof ack !== 'object' || (typeof ack.ts !== 'string' && ack.ok !== true)) {
      throw new Error(`report ack missing expected fields: ${JSON.stringify(ack).slice(0, 80)}`);
    }
    return ack;
  }
  throw lastErr;
}

// Heartbeat so /api/stats can tally block/http/network/parse outcomes. A fatal
// auth failure (401/403) is rethrown so a wrong key surfaces even on a blocked
// scan; transient heartbeat failures are swallowed (stats-only, not critical).
async function heartbeat(outcome) {
  try {
    await report({ heartbeat: true, outcome });
  } catch (e) {
    if (/fatal config/.test(e.message)) throw e;
    console.log(`  [heartbeat ${outcome}] failed (non-fatal): ${e.message}`);
  }
}

async function main() {
  if (!REPORT_KEY) {
    console.error('REPORT_KEY missing.');
    process.exit(1);
  }
  if (!/^https:\/\//i.test(REPORT_URL)) {
    console.error(`REPORT_URL must be https (got ${REPORT_URL}).`);
    process.exit(1);
  }
  if (KEYWORDS.length === 0) {
    console.error('COUPON_KEYWORDS is empty after trimming — nothing to match.');
    process.exit(1);
  }

  const ts = new Date().toISOString();
  const r = await scanWithRetry();

  // Non-ok outcomes: log distinctly + heartbeat the type. Heartbeat rethrows on
  // a fatal auth error → exit 1; otherwise exit 0 (these are external conditions,
  // visible in /api/stats).
  if (r.outcome !== 'ok') {
    console.log(`[${ts}] scan ${r.outcome}${r.detail ? ` (${r.detail})` : ''} after ${r.attempts} attempt(s) — reporter=${REPORTER_ID}`);
    if (r.outcome === 'parse-error') console.error('⚠️  PARSE ERROR — Myntra page structure may have changed. Investigate.');
    try {
      await heartbeat(r.outcome);
    } catch (e) {
      console.error(`[${ts}] ${e.message}`);
      process.exit(1); // fatal config (wrong key) surfaced even on a blocked scan
    }
    process.exit(0);
  }

  const deals = detect(r.products);
  try {
    const resp = await report({ productsSeen: r.products.length, deals });
    const note = deals.length
      ? ` 🟢 DEAL x${deals.length} (worker: new=${resp.newCount}, notified=${resp.notifiedCount})`
      : resp.cleared ? ' (worker: cleared, stop sent)' : '';
    console.log(`[${ts}] products=${r.products.length} attempts=${r.attempts} deals=${deals.length}${note}`);
    process.exit(0);
  } catch (e) {
    // ANY authoritative report that couldn't be delivered fails the run — a
    // failed `deals: []` may be the critical STOP transition just as much as a
    // failed deal alert. The worker's staleness guard is a backstop, not a
    // reason to hide the delivery failure.
    console.error(`[${ts}] report delivery failed: ${e.message}`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by tests).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
