#!/usr/bin/env python3
"""Probe the MiniMax token-plan remains API using the key stored in DSH's credential store.

The key is read from the credentials file and never printed.
"""
import json, re, sys, urllib.request, urllib.error

CREDS = r"C:\Users\nkb\.dsh\.credentials.yaml"

def read_ref(name):
    text = open(CREDS, encoding="utf-8").read()
    m = re.search(r"^\s*%s:\s*(.+?)\s*$" % re.escape(name), text, re.M)
    if not m:
        return None
    val = m.group(1).strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        val = val[1:-1]
    return val

def probe(base, key, path="/v1/token_plan/remains"):
    url = base.rstrip("/") + path
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, repr(e)

if __name__ == "__main__":
    key = read_ref("MINIMAX_CN_API_KEY")
    if not key:
        print("NO KEY FOUND")
        sys.exit(1)
    print("key loaded: len=%d prefix_scheme=%s" % (len(key), key[:3] if len(key) > 3 else "?"))
    for base in ("https://api.minimaxi.com", "https://www.minimax.io"):
        status, body = probe(base, key)
        print("\n=== %s -> %s ===" % (base, status))
        if isinstance(body, (dict, list)):
            print(json.dumps(body, indent=2, ensure_ascii=False)[:6000])
        else:
            print(str(body)[:2000])
