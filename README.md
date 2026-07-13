# blinkdeal-detector

Reads Myntra's gold-coin listing, detects the **BLINKDEAL** coupon, and reports
to the [blinkdeal.paype.co](https://blinkdeal.paype.co) worker, which owns
subscribers and SMS fan-out (it only notifies on deal **transitions**).

Plain `fetch` + embedded-JSON extraction — no headless browser, no npm deps,
Node 18+.

## Where to run it — read this

Myntra soft-blocks **datacenter IPs** (GitHub, Cloudflare, Render) with a
"Site Maintenance" stub. Only **residential/mobile IPs** get real data. And
GitHub throttles scheduled workflows to ~1.5–2.5h gaps (≈8% of the requested
rate) and can drop them entirely.

**So the primary detector must be a residential machine** (a Raspberry Pi,
always-on laptop, etc.) running `scan.js` every 5 min via cron. GitHub Actions
(`.github/workflows/detect.yml`) is only a best-effort **backup**.

Run on a Pi:
```bash
git clone https://github.com/rishabh-bansal/blinkdeal-detector.git ~/blinkdeal-detector
# cron, every 5 min:
*/5 * * * * cd $HOME/blinkdeal-detector && REPORT_KEY=<key> REPORTER_ID=pi node scan.js >> $HOME/blinkdeal.log 2>&1
```

Watch `https://blinkdeal.paype.co/api/status` → `reporterStale: true` means the
residential reporter has gone quiet (no report in ~15 min) — investigate.

## Config (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `REPORT_KEY` | — | Required. The worker's report-only key. |
| `REPORT_URL` | `https://blinkdeal.paype.co` | Must be https. |
| `REPORTER_ID` | `unknown` | `pi` / `github` / `laptop` — shown in `/api/stats`. |
| `MYNTRA_URL` | `https://www.myntra.com/gold-coin` | |
| `COUPON_KEYWORDS` | `blinkdeal` | Comma-separated; empty → error. |
| `MAX_ATTEMPTS` | `2` | Retries per run (transient outcomes only). |

## Behaviour / guarantees

- Fetches `?rows=100` — the max the page inlines (~94 of ~318 coins). `?p=`
  pagination does **not** work (Myntra returns the same batch); full coverage
  needs the authenticated search API. BLINKDEAL is category-wide, so the top ~94
  catch it; a product-specific coupon beyond #94 could be missed.
- **Typed scan outcomes**: only a verified "Site Maintenance" page counts as an
  expected `blocked`. `http-error`, `network-error`, and `parse-error` are logged
  distinctly and heartbeat to `/api/stats` — a broken scan is never mistaken for
  a cleared deal.
- **Reliable reporting**: requires `res.ok`; 401/403 are fatal config errors;
  429/5xx retried with backoff; an **undelivered deal exits non-zero** so it's
  visible. Redirects disabled (the `x-admin-key` is never forwarded elsewhere).

## Test

```bash
npm test    # node --test — extractor validation suite
```

## Stats

`GET https://blinkdeal.paype.co/api/stats` — daily working/blocked/error counts
per reporter (pi / github).
