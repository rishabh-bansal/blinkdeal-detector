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

// DFS a parsed object for the array that looks most like Myntra's product list.
// Prefers a value under a `products` key; otherwise the array with the most
// valid products. Returns { arr, valid, viaProductsKey } or null.
function bestProductArray(root) {
  let best = null;
  const seen = new Set();
  const visit = (node, key, depth) => {
    if (depth > 10 || node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const valid = validCount(node);
      const viaKey = key === 'products';
      if (valid > 0 || (viaKey && node.length === 0)) {
        if (
          !best ||
          valid > best.valid ||
          (valid === best.valid && viaKey && !best.viaProductsKey)
        ) {
          best = { arr: node, valid, viaProductsKey: viaKey };
        }
      }
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

// Fallback: parse each `"products":[ … ]` occurrence and keep the best.
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
    if ((valid > 0 || arr.length === 0) && (!best || valid > best.valid)) {
      best = { arr, valid };
    }
  }
  return best;
}

/**
 * Returns validated product objects, or null if no products structure was found.
 */
export function extractProducts(html) {
  if (!html || typeof html !== 'string') return null;

  let candidate = null;
  const myx = parseMyxBlob(html);
  if (myx) candidate = bestProductArray(myx);
  if (!candidate) candidate = scanProductsKey(html);
  if (!candidate) return null;

  return candidate.arr.filter(isValidProduct);
}
