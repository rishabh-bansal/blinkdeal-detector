# Diagnostic: on ONE GitHub runner IP, compare fetch methods against Myntra.
# Tells us whether the block is IP-based (all fail) or fingerprint-based
# (curl_cffi succeeds where plain fetch fails).
import urllib.request, ssl

URL = "https://www.myntra.com/gold-coin"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
H = {"User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9",
     "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}

def verdict(name, status, html):
    has = '"products":[' in html
    print(f"  {name:24s} HTTP {status} | {len(html):>7} bytes | products={'YES ✅' if has else 'no ❌'}")
    if not has and html:
        import re
        t = re.sub(r"\s+", " ", html[:160])
        print(f"      stub: {t}")
    return has

print("=== 1) plain urllib (Node/undici-like TLS) ===")
try:
    req = urllib.request.Request(URL, headers=H)
    with urllib.request.urlopen(req, timeout=25) as r:
        verdict("urllib", r.status, r.read().decode("utf-8", "replace"))
except Exception as e:
    print(f"  urllib error: {e}")

print("=== 2) curl_cffi impersonate chrome (real Chrome TLS/JA3/HTTP2) ===")
try:
    from curl_cffi import requests as creq
    for imp in ("chrome124", "chrome120", "chrome110"):
        try:
            r = creq.get(URL, headers={"Accept-Language": "en-IN,en;q=0.9"}, impersonate=imp, timeout=25)
            if verdict(f"curl_cffi[{imp}]", r.status_code, r.text):
                break
        except Exception as e:
            print(f"  curl_cffi[{imp}] error: {e}")
except ImportError:
    print("  curl_cffi not installed")

print("=== 3) curl_cffi via free proxy (optional, if PROXY set) ===")
import os
proxy = os.environ.get("TEST_PROXY")
if proxy:
    try:
        from curl_cffi import requests as creq
        r = creq.get(URL, impersonate="chrome124", proxies={"https": proxy, "http": proxy}, timeout=40)
        verdict("curl_cffi+proxy", r.status_code, r.text)
    except Exception as e:
        print(f"  proxy error: {e}")
else:
    print("  (no TEST_PROXY set — skipped)")
