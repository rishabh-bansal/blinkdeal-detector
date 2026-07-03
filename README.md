# blinkdeal-detector

Detects the **BLINKDEAL** coupon on Myntra gold-coin listings and reports to
the [blinkdeal.paype.co](https://blinkdeal.paype.co) worker, which sends SMS
alerts to subscribers.

Runs on **GitHub Actions** (the approach proven by the reference deal-tracker
repos): a scheduled workflow relaunches every 15 minutes; each run keeps a
burst monitor alive for ~13 minutes checking Myntra every 60 seconds. Plain
`fetch` + embedded-JSON extraction — no headless browser, no dependencies.

The worker only notifies on deal **transitions** (start/stop), so per-minute
reporting never spams anyone.

## Config

- `REPORT_KEY` — Actions secret, must match the worker's `ADMIN_KEY`.
- Workflow inputs (manual runs): `burst_minutes`, `interval_seconds`.
- Env overrides in `scan.js`: `MYNTRA_URL`, `COUPON_KEYWORDS`, `MAX_PAGES`.
