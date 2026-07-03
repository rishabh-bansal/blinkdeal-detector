// Extract the embedded product array from a Myntra listing page's HTML.
//
// Myntra server-renders search results into the page as JSON (inside
// `window.__myx = {...}` / a `"products":[...]` array). We pull that JSON out
// directly — no headless browser needed.
//
// Unlike the naive bracket-counters in the reference repos, this scanner is
// string-aware: it ignores brackets that appear inside JSON string values
// (product descriptions can contain "[" / "]"), so it won't miscount.

/**
 * Given HTML and the index of an opening bracket ('[' or '{'), return the
 * substring up to and including its matching close bracket, or null.
 */
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
    if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return str.slice(startIdx, i + 1);
    }
  }
  return null;
}

function looksLikeProducts(arr) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.some((o) => o && typeof o === 'object' && ('productId' in o || 'price' in o))
  );
}

// Strategy A: every `"products":` occurrence -> parse the array that follows.
function tryProductsArrays(html) {
  let from = 0;
  const key = '"products"';
  while (true) {
    const k = html.indexOf(key, from);
    if (k === -1) break;
    from = k + key.length;
    const bracket = html.indexOf('[', k);
    if (bracket === -1) continue;
    // Only accept if the '[' is right after the colon (avoid false hits).
    const between = html.slice(k + key.length, bracket);
    if (!/^\s*:\s*$/.test(between)) continue;
    const json = extractBalanced(html, bracket);
    if (!json) continue;
    try {
      const arr = JSON.parse(json);
      if (looksLikeProducts(arr)) return arr;
    } catch {
      // keep scanning
    }
  }
  return null;
}

// Strategy B: parse the whole `window.__myx = {...}` blob, then DFS for products.
function tryMyxBlob(html) {
  const markers = ['window.__myx =', 'window.__myx=', '__myx ='];
  for (const m of markers) {
    const idx = html.indexOf(m);
    if (idx === -1) continue;
    const brace = html.indexOf('{', idx);
    if (brace === -1) continue;
    const json = extractBalanced(html, brace);
    if (!json) continue;
    try {
      const root = JSON.parse(json);
      const found = dfsProducts(root);
      if (found) return found;
    } catch {
      // try next marker
    }
  }
  return null;
}

function dfsProducts(node, depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    if (looksLikeProducts(node)) return node;
    for (const item of node) {
      const r = dfsProducts(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (looksLikeProducts(node.products)) return node.products;
  for (const key of Object.keys(node)) {
    const r = dfsProducts(node[key], depth + 1);
    if (r) return r;
  }
  return null;
}

/**
 * Extract product objects from listing HTML. Returns [] if none found
 * (e.g. the page was an anti-bot challenge instead of real content).
 */
export function extractProducts(html) {
  if (!html || typeof html !== 'string') return [];
  return tryProductsArrays(html) || tryMyxBlob(html) || [];
}
