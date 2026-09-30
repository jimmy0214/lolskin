# -*- coding: utf-8 -*-
"""
整理腾讯 LOL 皮肤数据 (skins.js + hero_list.js) 为结构化数据集。

输入:
    data/raw/skins.js        https://game.gtimg.cn/images/lol/act/img/js/skins/skins.js
    data/raw/hero_list.js    https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js

输出 (data/):
    meta.json      版本/时间/统计
    heroes.json    英雄列表
    skins.json     原皮肤 + 皮肤 (2166 条)
    chromas.json   炫彩 (7032 条)
    manifest.json  全部图片任务清单 (供下载器与前端使用)
    stats.json     按英雄 / 按标签的聚合统计
"""
import json
import os
import re
import sys
from collections import Counter, OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data")
DATA = OUT


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_js_json(path):
    """某些 js 文件可能带 `var x = {...};` 包装，做一次宽松提取。"""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"([\[{].*[\]}])", text, re.S)
        if not m:
            raise
        return json.loads(m.group(1))


def norm_url(u):
    """统一成 https 协议。"""
    u = (u or "").strip()
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("http://"):
        return "https://" + u[len("http://"):]
    return u


def load_custom(path):
    """读取手动补充的皮肤（data/custom_skins.json），返回 [{heroId,skinId,name,rarity,img,isBase}]。"""
    if not os.path.exists(path):
        return []
    try:
        # utf-8-sig：兼容 Windows 记事本 / PowerShell 写出的 BOM 头
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001
        print("  ! custom_skins.json 解析失败，已忽略：%s" % e)
        return []
    if isinstance(data, dict):
        data = data.get("skins") or data.get("items") or []
    out = []
    for i, r in enumerate(data):
        if not isinstance(r, dict):
            continue
        sid = str(r.get("skinId") or r.get("id") or "").strip()
        hid = str(r.get("heroId") or "").strip()
        name = str(r.get("name") or "").strip()
        if not (sid.isdigit() and hid.isdigit() and name):
            print("  ! 跳过无效自定义条目 #%d：%s" % (i, r))
            continue
        out.append({
            "skinId": sid, "heroId": hid, "name": name,
            "rarity": str(r.get("rarity") or "").strip(),
            "img": norm_url(r.get("img") or r.get("image") or ""),
            "isBase": bool(r.get("isBase")),
        })
    return out


def img_name(url):
    return os.path.basename(url.split("?")[0])


def q(url, size=None):
    """给腾讯图片 URL 加尺寸参数（部分接口支持 ?imageMogr2/...）。"""
    return url


def main():
    skins_raw = read_js_json(os.path.join(RAW, "skins.js"))
    heroes_raw = read_js_json(os.path.join(RAW, "hero_list.js"))

    rows = skins_raw["skins"]
    # 排除 heroId=0 的“经典 XX”旧版残留皮肤：无 loadingImg、不属于任何英雄
    legacy = [r for r in rows if r["heroId"] == "0"]
    rows = [r for r in rows if r["heroId"] != "0"]
    hero_rows = heroes_raw["hero"]

    # ---------- 合并手动补充的皮肤（data/custom_skins.json） ----------
    custom = load_custom(os.path.join(DATA, "custom_skins.json"))
    if custom:
        existing = {r["skinId"] for r in rows}
        added = 0
        known_hero = {h["heroId"] for h in hero_rows}
        for c in custom:
            if c["skinId"] in existing:
                continue
            hid = c["heroId"]
            # 自定义条目挂在官方接口里还没有的英雄上时，补一个占位英雄，避免数据丢失
            if hid not in known_hero:
                hero_rows.append({
                    "heroId": hid, "name": "自定义英雄", "title": "英雄" + hid,
                    "alias": "", "keywords": "", "roles": [], "goldPrice": "",
                    "instance_id": "",
                })
                known_hero.add(hid)
            rows.append({
                "skinId": c["skinId"], "heroId": hid,
                "heroName": "", "heroTitle": "",
                "name": c["name"], "chromas": "0", "chromasBelongId": "0",
                "isBase": "1" if c["isBase"] else "0", "emblemsName": "",
                "description": "", "mainImg": c["img"], "iconImg": "",
                "loadingImg": c["img"], "videoImg": "", "sourceImg": "", "vedioPath": "",
                "suitType": "", "publishTime": "", "chromaImg": "", "heroOP": "",
                "heroOSP": "", "skinOSP": "", "labelId": "0", "centerImg": "",
                "instance_id": "", "skinlabel": "无",
                "_customRarity": c["rarity"],
            })
            existing.add(c["skinId"])
            added += 1
        print("  合并手动补充皮肤：%d 条" % added)

    hero_by_id = {h["heroId"]: h for h in hero_rows}

    # ---------- 分类 ----------
    by_id = {r["skinId"]: r for r in rows}
    chromas = [r for r in rows if r.get("chromaImg")]
    normals = [r for r in rows if not r.get("chromaImg")]
    bases = [r for r in normals if r.get("isBase") == "1"]
    paid = [r for r in normals if r.get("isBase") != "1"]

    # 每个皮肤的炫彩数量（用于 UI 展示 +1 / +8 角标）
    chroma_count = Counter()
    for c in chromas:
        chroma_count[c.get("chromasBelongId")] += 1

    # ---------- 英雄 ----------
    heroes = []
    for h in hero_rows:
        hid = h["heroId"]
        mine = [r for r in normals if r["heroId"] == hid]
        heroes.append(OrderedDict([
            ("heroId", hid),
            ("name", h["name"]),               # 称号，如 黑暗之女
            ("title", h["title"]),             # 名字，如 安妮
            ("alias", h["alias"]),             # Annie
            ("keywords", h.get("keywords", "")),
            ("roles", h.get("roles", [])),
            ("goldPrice", h.get("goldPrice", "")),
            ("instanceId", h.get("instance_id", "")),
            ("skinCount", len(mine)),
            ("chromaCount", sum(chroma_count[r["skinId"]] for r in mine)),
        ]))
    # 补上 hero_list 里没有、但 skins 里存在的英雄（容错）
    known = {h["heroId"] for h in heroes}
    for hid in sorted({r["heroId"] for r in rows} - known):
        mine = [r for r in normals if r["heroId"] == hid]
        if not mine:
            continue
        heroes.append(OrderedDict([
            ("heroId", hid), ("name", mine[0]["heroName"]), ("title", mine[0]["heroTitle"]),
            ("alias", ""), ("keywords", ""), ("roles", []), ("goldPrice", ""),
            ("instanceId", ""), ("skinCount", len(mine)),
            ("chromaCount", sum(chroma_count[r["skinId"]] for r in mine)),
        ]))

    def hero_key(h):
        return int(h["heroId"]) if str(h["heroId"]).isdigit() else 0
    heroes.sort(key=hero_key)

    # ---------- 皮肤 ----------
    def make_skin(r):
        loading = norm_url(r.get("loadingImg"))
        main = norm_url(r.get("mainImg"))
        center = norm_url(r.get("centerImg"))
        icon = norm_url(r.get("iconImg"))
        return OrderedDict([
            ("skinId", r["skinId"]),
            ("heroId", r["heroId"]),
            ("name", r["name"]),
            ("isBase", 1 if r.get("isBase") == "1" else 0),
            ("emblems", r.get("emblemsName") or r.get("_customRarity") or ""),
            ("label", r.get("skinlabel") or ""),
            ("publishTime", r.get("publishTime") or ""),
            ("loadingImg", loading),
            ("mainImg", main),
            ("centerImg", center),
            ("iconImg", icon),
            ("videoImg", norm_url(r.get("videoImg"))),
            ("heroOP", norm_url(r.get("heroOP"))),
            ("instanceId", r.get("instance_id") or ""),
            ("chromaCount", chroma_count[r["skinId"]]),
        ])

    skins = [make_skin(r) for r in bases + paid]
    skins.sort(key=lambda s: (hero_key({"heroId": s["heroId"]}), s["isBase"] == 0, int(s["skinId"])))

    def make_chroma(r):
        return OrderedDict([
            ("skinId", r["skinId"]),
            ("heroId", r["heroId"]),
            ("parentId", r.get("chromasBelongId") or ""),
            ("name", r["name"]),
            ("img", norm_url(r.get("chromaImg"))),
            ("instanceId", r.get("instance_id") or ""),
        ])

    chroma_list = [make_chroma(r) for r in chromas]
    chroma_list.sort(key=lambda c: (int(c["parentId"] or 0), int(c["skinId"])))

    # ---------- 图片清单 ----------
    manifest = OrderedDict()
    manifest["images"] = []
    for s in skins:
        # 下载优先级：loading(竖版原画) > main > center > icon
        for kind, url in (("loading", s["loadingImg"]), ("main", s["mainImg"]),
                          ("center", s["centerImg"]), ("icon", s["iconImg"])):
            if url:
                manifest["images"].append(OrderedDict([
                    ("skinId", s["skinId"]), ("heroId", s["heroId"]),
                    ("type", "base" if s["isBase"] else "skin"),
                    ("kind", kind), ("url", url), ("file", img_name(url)),
                ]))
    for c in chroma_list:
        if c["img"]:
            manifest["images"].append(OrderedDict([
                ("skinId", c["skinId"]), ("heroId", c["heroId"]),
                ("type", "chroma"), ("kind", "chroma"),
                ("url", c["img"]), ("file", img_name(c["img"])),
            ]))

    # 用于拼图的主图：皮肤取 loading，炫彩取 chroma
    primary = OrderedDict()
    for s in skins:
        primary[s["skinId"]] = s["loadingImg"] or s["mainImg"] or s["centerImg"] or s["iconImg"]
    for c in chroma_list:
        primary[c["skinId"]] = c["img"]

    # ---------- 统计 ----------
    label_counter = Counter(r.get("skinlabel") or "无" for r in normals)
    role_counter = Counter(role for h in heroes for role in h["roles"])
    stats = OrderedDict([
        ("heroCount", len(heroes)),
        ("baseSkinCount", len(bases)),
        ("paidSkinCount", len(paid)),
        ("skinCount", len(skins)),
        ("chromaCount", len(chroma_list)),
        ("totalCount", len(skins) + len(chroma_list)),
        ("skinsWithChroma", sum(1 for s in skins if s["chromaCount"] > 0)),
        ("missingLoading", sum(1 for s in skins if not s["loadingImg"])),
        ("excludedLegacy", len(legacy)),
        ("imageTaskCount", len(manifest["images"])),
        ("skinLabels", [{"label": k, "count": v} for k, v in label_counter.most_common()]),
        ("roleCounts", [{"role": k, "count": v} for k, v in role_counter.most_common()]),
    ])

    version = skins_raw.get("version", "")
    meta = OrderedDict([
        ("source", "https://game.gtimg.cn/images/lol/act/img/js/skins/skins.js"),
        ("heroSource", "https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js"),
        ("version", version),
        ("fileTime", skins_raw.get("fileTime", "")),
        ("generatedAt", __import__("datetime").datetime.now().isoformat(timespec="seconds")),
        ("stats", stats),
    ])

    os.makedirs(OUT, exist_ok=True)

    def dump(name, obj, compact=True):
        p = os.path.join(OUT, name)
        with open(p, "w", encoding="utf-8") as f:
            if compact:
                json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
            else:
                json.dump(obj, f, ensure_ascii=False, indent=2)
        print("  %-16s %8.1f KB" % (name, os.path.getsize(p) / 1024))

    dump("heroes.json", heroes)
    dump("skins.json", skins)
    dump("chromas.json", chroma_list)
    dump("manifest.json", manifest)
    dump("primary.json", primary)
    dump("meta.json", meta, compact=False)
    dump("stats.json", stats, compact=False)

    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
