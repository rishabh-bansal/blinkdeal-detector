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
const INTERVAL_SECONDS = parseInt(process.env.INTERVAL_SECONDS || '60', 10);

// Burst duration. "auto" (default) uses the 100-day BLINKDEAL pattern data:
// sessions start almost exclusively 6 AM–9 PM IST, so inside the active
// window (07–23 IST) we run full 13-min bursts; overnight we do one quick
// check and exit (the workflow cron also runs less often overnight).
const ACTIVE_START_IST = parseInt(process.env.ACTIVE_START_IST || '7', 10);
const ACTIVE_END_IST = parseInt(process.env.ACTIVE_END_IST || '23', 10);

function istHour() {
  return new Date(Date.now() + 330 * 60000).getUTCHours();
}

function resolveBurstMinutes() {
  const raw = process.env.BURST_MINUTES || 'auto';
  const n = parseFloat(raw);
  if (Number.isFinite(n)) return { minutes: n, mode: 'explicit' };
  const h = istHour();
  const active = h >= ACTIVE_START_IST && h < ACTIVE_END_IST;
  return { minutes: active ? 13 : 0.05, mode: active ? 'auto-active' : 'auto-offhours' };
}

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

// ── Browser fallback ─────────────────────────────────────────────────────────
// Plain fetch is sometimes served an Akamai challenge stub (~500 bytes) on
// GitHub runners. Real Chrome executes the challenge and gets the page — the
// approach the reference Blinkdeal repo ran successfully for months. We start
// the browser lazily on first block and reuse it for the rest of the run.
let browserCtx = null;
let useBrowser = false;

async function getBrowserPage() {
  if (browserCtx) return browserCtx.page;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });
  await context.addInitScript(
    "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
  );
  const page = await context.newPage();
  browserCtx = { browser, page };
  return page;
}

export async function closeBrowser() {
  if (browserCtx) {
    await browserCtx.browser.close().catch(() => {});
    browserCtx = null;
  }
}

async function fetchHtmlPlain(url) {
  const res = await fetch(url, { headers: headers(), redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const html = await res.text();
  return { status: res.status, html };
}

async function fetchHtmlBrowser(url) {
  const page = await getBrowserPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500); // let the challenge/content settle
  return { status: 200, html: await page.content() };
}

async function fetchListingHtml(url, pageNo) {
  if (!useBrowser) {
    const r = await fetchHtmlPlain(url);
    if (extractProducts(r.html).length > 0) return r;
    console.log(`  [scan] plain fetch blocked on page ${pageNo} (HTTP ${r.status}, len=${r.html.length}) — switching to browser`);
    try {
      useBrowser = true;
      return await fetchHtmlBrowser(url);
    } catch (e) {
      useBrowser = false; // playwright unavailable (e.g. local run) — stay on fetch
      console.log(`  [scan] browser fallback unavailable: ${e.message.split('\n')[0]}`);
      return r;
    }
  }
  return fetchHtmlBrowser(url);
}

async function scan() {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = MYNTRA_URL.includes('?') ? '&' : '?';
    const url = page === 1 ? MYNTRA_URL : `${MYNTRA_URL}${sep}p=${page}`;
    let html = '';
    try {
      ({ html } = await fetchListingHtml(url, page));
    } catch (e) {
      console.log(`  [scan] page ${page} fetch failed: ${e.message.split('\n')[0]}`);
      break;
    }
    const products = extractProducts(html);
    if (!products.length) {
      if (page === 1) console.log(`  [scan] page 1 len=${html.length}, no products (mode=${useBrowser ? 'browser' : 'fetch'})`);
      break;
    }
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
  const { minutes: burstMinutes, mode } = resolveBurstMinutes();
  const jobStart = Date.now();
  let deadline = jobStart + burstMinutes * 60 * 1000;
  // Never exceed the workflow's 15-min job timeout, even after extensions.
  const hardCap = jobStart + 14 * 60 * 1000;
  console.log(`Burst monitor [${mode}]: ${burstMinutes} min, every ${INTERVAL_SECONDS}s, keywords=[${KEYWORDS}] (IST hour ${istHour()})`);

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
        // A deal is live: keep tracking it (fast stop detection) even if this
        // run started as a quick off-hours check — up to the job's hard cap.
        if (deals.length > 0) {
          deadline = Math.min(Math.max(deadline, Date.now() + 5 * 60 * 1000), hardCap);
        }
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

  console.log(`Burst done: ${cycles} cycles, ${blockedCycles} blocked/empty (mode=${useBrowser ? 'browser' : 'fetch'}).`);
  await closeBrowser();
  if (cycles > 0 && blockedCycles === cycles) {
    console.error('EVERY cycle returned 0 products — Myntra may be blocking this runner. Investigate.');
    process.exit(2); // surface as a failed run so it's visible
  }
}

main();
