# -*- coding: utf-8 -*-
"""
下载皮肤小图标（60x60 iconImg），用途：海报式拼图的背景马赛克。

落盘: images/icons/{heroId}/{skinId}.jpg
产物: data/icons.json   skinId -> 相对路径
"""
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT_ROOT = os.path.join(ROOT, "images", "icons")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"

_lock = threading.Lock()
_done = 0
_fail = []
_bytes = 0
_t0 = 0.0
_total = 0


def tasks():
    with open(os.path.join(DATA, "skins.json"), encoding="utf-8") as f:
        skins = json.load(f)
    out = []
    for s in skins:
        if not s.get("iconImg"):
            continue
        ext = os.path.splitext(s["iconImg"].split("?")[0])[1].lower() or ".jpg"
        dest = os.path.join(OUT_ROOT, s["heroId"], s["skinId"] + ext)
        out.append({"skinId": s["skinId"], "url": s["iconImg"], "path": dest})
    return out


def fetch(url, dest, retries=4):
    last = None
    for i in range(retries):
        try:
            req = Request(url, headers={"User-Agent": UA, "Referer": "https://lol.qq.com/"})
            with urlopen(req, timeout=25) as r:
                body = r.read()
            if len(body) < 64:
                raise ValueError("too small")
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, dest)
            return len(body)
        except (HTTPError, URLError, ValueError, OSError) as e:
            last = e
            time.sleep(0.5 * (i + 1))
    raise last


def handle(t):
    global _done, _bytes
    if os.path.exists(t["path"]) and os.path.getsize(t["path"]) > 64:
        with _lock:
            _done += 1
            d = _done
        if d % 50 == 0:
            report()
        return True
    os.makedirs(os.path.dirname(t["path"]), exist_ok=True)
    try:
        n = fetch(t["url"], t["path"])
    except Exception as e:  # noqa: BLE001
        with _lock:
            _fail.append({"skinId": t["skinId"], "url": t["url"], "error": str(e)})
            _done += 1
            d = _done
        if d % 50 == 0:
            report()
        return False
    with _lock:
        _bytes += n
        _done += 1
        d = _done
    if d % 50 == 0:
        report()
    return True


def report():
    el = time.time() - _t0
    rate = _done / el if el else 0
    sys.stdout.write("\r  icons %4d/%d  失败 %-3d  %5.1f MB  %4.1f/s   " %
                     (_done, _total, len(_fail), _bytes / 1048576, rate))
    sys.stdout.flush()


def main():
    global _total, _t0
    ts = tasks()
    _total = len(ts)
    _t0 = time.time()
    print("图标下载 %d 张 -> %s" % (_total, OUT_ROOT))
    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(handle, ts))
    report()
    print()
    index = {}
    for t in ts:
        if os.path.exists(t["path"]) and os.path.getsize(t["path"]) > 64:
            index[t["skinId"]] = os.path.relpath(t["path"], ROOT).replace("\\", "/")
    with open(os.path.join(DATA, "icons.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    print("成功 %d / 失败 %d -> data/icons.json" % (len(index), len(_fail)))


if __name__ == "__main__":
    main()
