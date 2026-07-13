// Extract the embedded product array from a Myntra listing page's HTML.
//
// Myntra server-renders search results into the page as JSON (inside
// `window.__myx = {...}` / a `"products":[...]` array). We pull that JSON out
// directly — no headless browser needed.
//
// Contract:
//   - returns an ARRAY of validated product objects on success (may be empty
//     only if Myntra genuinely served an empty products array),
//   - returns NULL when no products structure could be found/parsed (so callers
//     can distinguish "no deal" from "couldn't read the page" — a schema
//     regression or a non-listing page must NOT look like a cleared deal).
//
// String-aware bracket scanning (ignores brackets inside JSON strings), entry
// validation (every entry must be a real Myntra product), and a preference for
// the largest valid array guard against picking an analytics `dataLayer.products`
// blob or crashing on a `[null, …]` array.

export function extractBalanced(str, startIdx) {
  const open = str[startIdx];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return str.slice(startIdx, i + 1);
    }
  }
  return null;
}

// A real Myntra product: has a productId AND a numeric price. Requiring
// productId (not just `id`) rejects analytics/dataLayer product arrays.
function isValidProduct(o) {
  if (!o || typeof o !== 'object') return false;
  const hasId = typeof o.productId === 'number' || typeof o.productId === 'string';
  return hasId && typeof o.price === 'number';
}

function validCount(arr) {
  if (!Array.isArray(arr)) return -1;
  let n = 0;
  for (const o of arr) if (isValidProduct(o)) n++;
  return n;
}

// DFS fallback for the array with the MOST valid products. Only ever considers
// arrays that contain at least one real product — an empty array (e.g. an
// analytics `dataLayer.products: []`) is never a candidate, so it can't be
// mistaken for a genuine "no deals" result.
function bestProductArray(root) {
  let best = null;
  const seen = new Set();
  const visit = (node, key, depth) => {
    if (depth > 10 || node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const valid = validCount(node);
      if (valid > 0 && (!best || valid > best.valid)) best = { arr: node, valid };
      for (const item of node) visit(item, key, depth + 1);
      return;
    }
    for (const k of Object.keys(node)) visit(node[k], k, depth + 1);
  };
  visit(root, null, 0);
  return best;
}

function parseMyxBlob(html) {
  for (const marker of ['window.__myx =', 'window.__myx=', '__myx =']) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const brace = html.indexOf('{', idx);
    if (brace === -1) continue;
    const json = extractBalanced(html, brace);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      /* try next marker */
    }
  }
  return null;
}

// Fallback: parse each `"products":[ … ]` occurrence and keep the one with the
// most valid products. Empty arrays are never accepted.
function scanProductsKey(html) {
  const key = '"products"';
  let from = 0;
  let best = null;
  while (true) {
    const k = html.indexOf(key, from);
    if (k === -1) break;
    from = k + key.length;
    const bracket = html.indexOf('[', k);
    if (bracket === -1) continue;
    if (!/^\s*:\s*$/.test(html.slice(k + key.length, bracket))) continue;
    const json = extractBalanced(html, bracket);
    if (!json) continue;
    let arr;
    try {
      arr = JSON.parse(json);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const valid = validCount(arr);
    if (valid > 0 && (!best || valid > best.valid)) best = { arr, valid };
  }
  return best;
}

/**
 * Returns { products, exact }.
 *   products: validated product array, or NULL if nothing could be located.
 *             NULL means "couldn't read the page" — callers must treat it as
 *             unknown, never as "no deals". An empty array is NEVER returned
 *             as success (a present-but-empty exact array ⇒ null too).
 *   exact:    true only if products came from Myntra's known, exact
 *             `searchData.results.products` path. false means a heuristic
 *             fallback (DFS best-array or generic `"products":[...]` scan)
 *             selected the array — it could in principle be the wrong array,
 *             so callers should NOT treat a fallback-sourced empty-deals
 *             result as an authoritative "clear" (see detect() callers).
 */
export function extractProductsWithMeta(html) {
  if (!html || typeof html !== 'string') return { products: null, exact: false };

  const myx = parseMyxBlob(html);
  if (myx) {
    // Prefer Myntra's exact, known search-results path. This avoids ever
    // selecting a competing array (plaProducts, recommendations, dataLayer).
    const exact = myx?.searchData?.results?.products;
    if (Array.isArray(exact)) {
      const valid = exact.filter(isValidProduct);
      return { products: valid.length > 0 ? valid : null, exact: true }; // present-but-empty ⇒ block/error
    }
    // Exact path absent (structure changed) → largest valid array as a fallback.
    const best = bestProductArray(myx);
    if (best) return { products: best.arr.filter(isValidProduct), exact: false };
  }

  const b = scanProductsKey(html);
  if (b) return { products: b.arr.filter(isValidProduct), exact: false };
  return { products: null, exact: false };
}

/** Back-compat wrapper: same as extractProductsWithMeta(html).products. */
export function extractProducts(html) {
  return extractProductsWithMeta(html).products;
}
