# -*- coding: utf-8 -*-
"""
同步腾讯官方最新数据到本地（新增英雄 / 新增皮肤的主流程）。

做四件事：
  1. 下载官方最新的 skins.js 与 hero_list.js 到 data/raw/
     （旧文件自动归档为 data/raw/archive/skins.<时间戳>.js，随时可回滚）
  2. 和本地比对，打印新增/移除的英雄与皮肤
  3. 重建结构化数据集（调用 organize_data.py）
  4. 只下载"新出现"的图片（已有图片自动跳过），并重试历史失败项

用法:
  python tools/sync.py                 # 全流程
  python tools/sync.py --dry-run       # 只看差异，不写任何文件
  python tools/sync.py --no-download   # 只更新数据，不下图
  python tools/sync.py --patch data/pending.patch.json   # 按后台生成的补丁只下这些条目
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(DATA, "raw")
ARCHIVE = os.path.join(RAW, "archive")
PY = sys.executable

SOURCES = {
    "skins.js": "https://game.gtimg.cn/images/lol/act/img/js/skins/skins.js",
    "hero_list.js": "https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js",
}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"


def log(msg):
    print(msg, flush=True)


def fetch(url, dest, retries=4):
    last = None
    for i in range(retries):
        try:
            req = Request(url, headers={"User-Agent": UA, "Referer": "https://lol.qq.com/"})
            with urlopen(req, timeout=60) as r:
                body = r.read()
            if len(body) < 1024:
                raise ValueError("内容过小（%d 字节），可能不是数据文件" % len(body))
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, dest)
            return len(body)
        except (HTTPError, URLError, ValueError, OSError) as e:
            last = e
            time.sleep(1.0 * (i + 1))
    raise last


def read_json(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8-sig") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return None


def ids_of(skins_raw):
    rows = skins_raw.get("skins", []) if skins_raw else []
    return {r["skinId"]: r for r in rows}


def hero_ids_of(hero_raw):
    rows = hero_raw.get("hero", []) if hero_raw else []
    return {h["heroId"]: h for h in rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只比差异，不写文件")
    ap.add_argument("--no-download", action="store_true", help="跳过图片下载")
    ap.add_argument("--patch", default=os.path.join(DATA, "pending.patch.json"),
                    help="后台生成的差异补丁（用于缩小下载范围）")
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    os.makedirs(RAW, exist_ok=True)
    os.makedirs(ARCHIVE, exist_ok=True)

    log("== LOL 皮肤数据同步 ==")
    log("项目目录: %s" % ROOT)

    # ---------- 1. 拉取最新官方数据 ----------
    remote = {}
    for name, url in SOURCES.items():
        tmp = os.path.join(RAW, name + ".new")
        try:
            n = fetch(url, tmp)
        except Exception as e:  # noqa: BLE001
            log("  ! 下载 %s 失败：%s" % (name, e))
            log("    如果是网络问题，可稍后重试；本地数据未受影响。")
            return 2
        remote[name] = (tmp, n)
        log("  已下载 %-14s %8.1f KB" % (name, n / 1024))

    # ---------- 2. 比对差异 ----------
    old_skins = read_json(os.path.join(RAW, "skins.js"))
    old_heroes = read_json(os.path.join(RAW, "hero_list.js"))
    new_skins = read_json(remote["skins.js"][0])
    new_heroes = read_json(remote["hero_list.js"][0])

    if new_skins is None or new_heroes is None:
        log("  ! 新的数据文件解析失败，已放弃本次同步（本地数据未受影响）")
        for tmp, _ in remote.values():
            if os.path.exists(tmp):
                os.remove(tmp)
        return 3

    o_id, n_id = ids_of(old_skins), ids_of(new_skins)
    o_hid, n_hid = hero_ids_of(old_heroes), hero_ids_of(new_heroes)
    add_ids = [k for k in n_id if k not in o_id]
    del_ids = [k for k in o_id if k not in n_id]
    add_hids = [k for k in n_hid if k not in o_hid]
    del_hids = [k for k in o_hid if k not in n_hid]

    log("  版本: %s -> %s" % (old_skins.get("version", "?") if old_skins else "无",
                             new_skins.get("version", "?")))
    log("  英雄: %d -> %d（新增 %d，移除 %d）" % (len(o_hid), len(n_hid), len(add_hids), len(del_hids)))
    log("  皮肤+炫彩: %d -> %d（新增 %d，移除 %d）" % (len(o_id), len(n_id), len(add_ids), len(del_ids)))

    for hid in add_hids:
        h = n_hid[hid]
        log("    + 新英雄 %s  %s / %s" % (hid, h.get("name", ""), h.get("title", "")))
    for sid in add_ids[:40]:
        r = n_id[sid]
        hid = r.get("heroId")
        hn = n_hid.get(hid, {}).get("title") or r.get("heroTitle") or hid
        log("    + 新条目 %s  [%s] %s" % (sid, hn, r.get("name", "")))
    if len(add_ids) > 40:
        log("    … 其余 %d 条省略" % (len(add_ids) - 40))

    if args.dry_run:
        log("\n--dry-run：未写入任何文件")
        for tmp, _ in remote.values():
            if os.path.exists(tmp):
                os.remove(tmp)
        return 0

    if not add_ids and not add_hids and not del_ids and not del_hids:
        log("\n本地已是最新，无需更新。")
        for tmp, _ in remote.values():
            if os.path.exists(tmp):
                os.remove(tmp)
        if not args.no_download:
            log("仍会补下历史失败的图片（如果有）。")
        else:
            return 0

    # ---------- 3. 归档旧文件并替换 ----------
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for name in SOURCES:
        cur = os.path.join(RAW, name)
        if os.path.exists(cur):
            shutil.copy2(cur, os.path.join(ARCHIVE, "%s.%s.bak" % (name, stamp)))
        os.replace(remote[name][0], cur)
    log("  已更新 data/raw/（旧文件归档到 data/raw/archive/*.%s.bak）" % stamp)

    # 记录本次差异，便于回溯
    report = {
        "syncedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "version": new_skins.get("version", ""),
        "newHeroes": [{"heroId": k, "name": n_hid[k].get("name", ""), "title": n_hid[k].get("title", "")}
                      for k in add_hids],
        "newSkinIds": add_ids,
        "removedSkinIds": del_ids,
        "removedHeroIds": del_hids,
    }
    with open(os.path.join(DATA, "last_sync.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    # ---------- 4. 重建数据集 ----------
    log("\n  重建结构化数据 …")
    r = subprocess.run([PY, os.path.join(ROOT, "tools", "organize_data.py")], cwd=ROOT)
    if r.returncode != 0:
        log("  ! organize_data.py 执行失败")
        return 4

    if args.no_download:
        log("\n--no-download：跳过图片下载")
        return 0

    # ---------- 5. 只下新图 ----------
    log("\n  下载新增图片（已存在的会自动跳过）…")
    subprocess.run([PY, os.path.join(ROOT, "tools", "download_images.py"),
                    "--workers", str(args.workers)], cwd=ROOT)
    subprocess.run([PY, os.path.join(ROOT, "tools", "download_icons.py")], cwd=ROOT)

    # 历史失败项补下
    fail_log = os.path.join(DATA, "download_failed.json")
    fails = read_json(fail_log)
    if fails:
        log("\n  重试历史失败图片 %d 张 …" % len(fails))
        subprocess.run([PY, os.path.join(ROOT, "tools", "download_images.py"),
                        "--retry", "--workers", "6"], cwd=ROOT)

    log("\n完成。刷新网页即可看到新英雄 / 新皮肤（顶栏版本号会变化）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
