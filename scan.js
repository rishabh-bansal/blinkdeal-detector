// BLINKDEAL detector — runs on GitHub Actions (burst mode).
//
// Pattern proven by the reference repos: a scheduled workflow keeps this
// process alive for ~13 minutes, checking Myntra every 60s, then exits and the
// cron relaunches it. Each trustworthy scan is reported to the blinkdeal
// Worker (blinkdeal.paype.co), which owns subscribers + SMS fan-out and only
// notifies on deal transitions — so reporting every minute is safe.
//
// Zero npm dependencies: Node 20+ built-in fetch only.
import { extractProducts } from './extractProducts.js';

const REPORT_URL = (process.env.REPORT_URL || 'https://blinkdeal.paype.co').replace(/\/$/, '');
const REPORT_KEY = process.env.REPORT_KEY || '';
const MYNTRA_URL = process.env.MYNTRA_URL || 'https://www.myntra.com/gold-coin';
const KEYWORDS = (process.env.COUPON_KEYWORDS || 'blinkdeal')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '2', 10);
const BURST_MINUTES = parseFloat(process.env.BURST_MINUTES || '13');
const INTERVAL_SECONDS = parseInt(process.env.INTERVAL_SECONDS || '60', 10);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function headers() {
  return {
    'User-Agent': UA,
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

async function scan() {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = MYNTRA_URL.includes('?') ? '&' : '?';
    const url = page === 1 ? MYNTRA_URL : `${MYNTRA_URL}${sep}p=${page}`;
    let html = '';
    try {
      const res = await fetch(url, { headers: headers(), redirect: 'follow', signal: AbortSignal.timeout(20000) });
      html = await res.text();
      if (page === 1 && !html.includes('"products"')) {
        console.log(`  [scan] page 1 HTTP ${res.status}, len=${html.length}, no products JSON — possibly blocked`);
      }
    } catch (e) {
      console.log(`  [scan] page ${page} fetch failed: ${e.message}`);
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

function detect(products) {
  const deals = [];
  for (const p of products) {
    const cd = p.couponData || {};
    const coupon = [cd.couponDescription, cd.description, cd.couponText, cd.label, p.offerText]
      .filter(Boolean).join(' ');
    const title = p.product || p.productName || '';
    const hay = `${title} ${coupon}`.toLowerCase();
    const matched = KEYWORDS.find((k) => hay.includes(k));
    if (!matched) continue;
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
    process.exit(1);
  }
  const deadline = Date.now() + BURST_MINUTES * 60 * 1000;
  console.log(`Burst monitor: ${BURST_MINUTES} min, every ${INTERVAL_SECONDS}s, keywords=[${KEYWORDS}]`);

  let cycles = 0, blockedCycles = 0;
  while (Date.now() < deadline) {
    cycles++;
    const t0 = Date.now();
    try {
      const products = await scan();
      const deals = detect(products);
      if (products.length === 0) {
        blockedCycles++;
        console.log(`[${new Date().toISOString()}] 0 products (blocked/empty) — not reported`);
      } else {
        const r = await report(deals, products.length);
        const note = deals.length
          ? ` 🟢 DEAL x${deals.length} (worker: new=${r.newCount}, notified=${r.notifiedCount})`
          : r.cleared ? ' (worker: cleared, stop sent)' : '';
        console.log(`[${new Date().toISOString()}] products=${products.length} deals=${deals.length}${note}`);
      }
    } catch (e) {
      console.log(`[${new Date().toISOString()}] cycle error: ${e.message}`);
      if (/REPORT_KEY rejected/.test(e.message)) process.exit(1);
    }
    const elapsed = Date.now() - t0;
    const sleep = Math.max(0, INTERVAL_SECONDS * 1000 - elapsed);
    if (Date.now() + sleep >= deadline) break;
    await new Promise((r) => setTimeout(r, sleep));
  }

  console.log(`Burst done: ${cycles} cycles, ${blockedCycles} blocked/empty.`);
  if (cycles > 0 && blockedCycles === cycles) {
    console.error('EVERY cycle returned 0 products — Myntra may be blocking this runner. Investigate.');
    process.exit(2); // surface as a failed run so it's visible
  }
}

main();
