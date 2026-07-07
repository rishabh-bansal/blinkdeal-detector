import urllib.request, json

def probe(name, url, headers):
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read(600).decode("utf-8","replace"); code = r.status
    except urllib.error.HTTPError as e:
        body = e.read(600).decode("utf-8","replace"); code = e.code
    except Exception as e:
        body = f"ERR {e}"; code = "ERR"
    stub = "Site Maintenance" in body
    print(f"{name}: HTTP {code} | {'MAINT-STUB(IP-BLOCKED)' if stub else 'reachable'} | {body[:90].strip()!r}")

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
import uuid; dev=str(uuid.uuid4())
apiH={"accept":"application/json","user-agent":UA,"x-myntraweb":"Yes","x-requested-with":"browser",
      "x-meta-app":f"deviceId={dev}","x-myntra-app":f"deviceID={dev};appFamily=MyntraRetailWeb;","deviceid":dev,
      "referer":"https://www.myntra.com/gold-coin"}
print("=== from GitHub datacenter IP ===")
probe("HTML  /gold-coin        ", "https://www.myntra.com/gold-coin", {"user-agent":UA,"accept":"text/html"})
probe("API   /gateway/v2/search", "https://www.myntra.com/gateway/v2/search/gold-coin?rows=5", apiH)
probe("API   /gateway/v2/product","https://www.myntra.com/gateway/v2/product/31416920", apiH)
