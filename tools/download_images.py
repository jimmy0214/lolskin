# -*- coding: utf-8 -*-
"""
全量下载英雄联盟皮肤原画（loadingImg）到本地。

规则（按用户要求）:
  - 原皮肤 / 皮肤 / 炫彩 一律只下载 loadingImg 这一个字段
  - 没有 loadingImg 的条目跳过（原始素材缺失，不做字段回退）

落盘结构:
  images/{heroId}/{skinId}.{ext}

产物:
  data/images.json    skinId -> 相对路径 索引（前端拼图用）

用法:
  python tools/download_images.py                  # 全量、跳过已存在
  python tools/download_images.py --limit 50       # 只下 50 张（自测）
  python tools/download_images.py --workers 24
  python tools/download_images.py --only chroma
  python tools/download_images.py --only skin
  python tools/download_images.py --retry          # 重试上次失败的
  python tools/download_images.py --manifest       # 生成 data/loading_jobs.json 后退出
"""
import argparse
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
IMG_ROOT = os.path.join(ROOT, "images")
FAIL_LOG = os.path.join(DATA, "download_failed.json")
JOBS = os.path.join(DATA, "loading_jobs.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_lock = threading.Lock()
_done = 0
_fail = []
_skip = 0
_total = 0
_bytes = 0
_t0 = 0.0


def build_tasks(only=None, for_retry=False):
    """只取 loadingImg。返回 [{skinId, heroId, type, url}]"""
    tasks = []
    if only in (None, "skin", "all"):
        with open(os.path.join(DATA, "skins.json"), encoding="utf-8") as f:
            for s in json.load(f):
                if not s.get("loadingImg"):
                    continue
                tasks.append({
                    "skinId": s["skinId"], "heroId": s["heroId"],
                    "type": "base" if s["isBase"] else "skin",
                    "url": s["loadingImg"],
                })
    if only in (None, "chroma", "all"):
        with open(os.path.join(DATA, "chromas.json"), encoding="utf-8") as f:
            for c in json.load(f):
                # 炫彩没有 loadingImg 字段，官方图源就是 chromaImg（skinloading/*.png）
                if not c.get("img"):
                    continue
                tasks.append({
                    "skinId": c["skinId"], "heroId": c["heroId"],
                    "type": "chroma", "url": c["img"],
                })
    return tasks


def local_path(task, url=None):
    ext = os.path.splitext((url or task["url"]).split("?")[0])[1].lower() or ".jpg"
    hid = task["heroId"] if str(task["heroId"]).isdigit() else "0"
    return os.path.join(IMG_ROOT, hid, task["skinId"] + ext)


def fetch(url, dest, retries=4):
    last = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": UA, "Referer": "https://lol.qq.com/"})
            with urlopen(req, timeout=30) as r:
                body = r.read()
            if not body or len(body) < 256:
                raise ValueError("response too small (%d bytes)" % len(body))
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, dest)
            return len(body)
        except (HTTPError, URLError, ValueError, OSError) as e:
            last = e
            time.sleep(0.6 * (attempt + 1))
    raise last


def handle(task):
    global _done, _skip, _bytes
    dest = local_path(task)
    task["path"] = dest
    if os.path.exists(dest) and os.path.getsize(dest) > 256:
        with _lock:
            _skip += 1
        return True
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        n = fetch(task["url"], dest)
    except Exception as e:  # noqa: BLE001
        with _lock:
            _fail.append({"skinId": task["skinId"], "heroId": task["heroId"],
                          "type": task["type"], "url": task["url"],
                          "error": "%s: %s" % (type(e).__name__, e)})
            _done += 1
            done = _done
        if done % 25 == 0:
            report(done)
        return False
    with _lock:
        _bytes += n
        _done += 1
        done = _done
    if done % 25 == 0:
        report(done)
    return True


def report(done):
    el = time.time() - _t0
    rate = done / el if el > 0 else 0
    left = (_total - done) / rate if rate > 0 else 0
    sys.stdout.write("\r  %5d/%d  失败 %-4d  跳过 %-5d  %7.1f MB  %5.1f 张/s  剩余 %s   "
                     % (done, _total, len(_fail), _skip, _bytes / 1048576, rate, fmt(left)))
    sys.stdout.flush()


def fmt(sec):
    sec = int(max(0, sec))
    return "%d:%02d:%02d" % (sec // 3600, sec % 3600 // 60, sec % 60)


def main():
    global _total, _t0
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", choices=["skin", "chroma", "all"], default=None)
    ap.add_argument("--retry", action="store_true", help="只重试 download_failed.json 里的条目")
    ap.add_argument("--manifest", action="store_true", help="只生成 loading_jobs.json")
    args = ap.parse_args()

    if args.manifest:
        tasks = build_tasks(args.only)
        for t in tasks:
            t["path"] = os.path.relpath(local_path(t), ROOT).replace("\\", "/")
        with open(JOBS, "w", encoding="utf-8") as f:
            json.dump(tasks, f, ensure_ascii=False, indent=2)
        print("生成 %d 条下载任务 -> %s" % (len(tasks), JOBS))
        return

    if args.retry and os.path.exists(FAIL_LOG):
        with open(FAIL_LOG, encoding="utf-8") as f:
            tasks = json.load(f)
        print("重试上次失败 %d 条" % len(tasks))
    else:
        tasks = build_tasks(args.only)

    if args.limit:
        tasks = tasks[:args.limit]

    _total = len(tasks)
    _t0 = time.time()
    print("待下载 %d 张 loadingImg -> %s  (并发 %d)" % (_total, IMG_ROOT, args.workers))

    index = {}
    idx_path = os.path.join(DATA, "images.json")
    if os.path.exists(idx_path):
        with open(idx_path, encoding="utf-8") as f:
            index = json.load(f)

    ok = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for res in ex.map(handle, tasks):
            if res:
                ok += 1
    for t in tasks:
        p = t.get("path") or local_path(t)
        if os.path.exists(p) and os.path.getsize(p) > 256:
            index[t["skinId"]] = os.path.relpath(p, ROOT).replace("\\", "/")

    report(_done)
    print()
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    with open(FAIL_LOG, "w", encoding="utf-8") as f:
        json.dump(_fail, f, ensure_ascii=False, indent=2)

    print("成功 %d / 跳过(已存在) %d / 失败 %d" % (ok, _skip, len(_fail)))
    print("本地图片索引 %d 条 -> data/images.json" % len(index))
    print("耗时 %s" % fmt(time.time() - _t0))
    if _fail:
        print("失败清单 -> data/download_failed.json （可用 --retry 重试）")


if __name__ == "__main__":
    main()
