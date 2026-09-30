# -*- coding: utf-8 -*-
"""
一条命令跑完整条数据流水线（新增英雄 / 皮肤后最常用）。

  python tools/build_all.py                 # 整理数据 + 增量下载图片
  python tools/build_all.py --no-download   # 只整理数据
  python tools/build_all.py --with-icons    # 连 60x60 图标一起下（海报背景用）
  python tools/build_all.py --skip-organize # 只补图，不重新整理数据

各步骤本身都是幂等的：已存在的图片会跳过，所以重复执行很安全。
"""
import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable


def run(title, script, extra=None):
    print("\n== %s ==" % title, flush=True)
    cmd = [PY, os.path.join(ROOT, "tools", script)] + (extra or [])
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        print("  ! %s 失败（退出码 %d）" % (script, r.returncode))
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-organize", action="store_true")
    ap.add_argument("--no-download", action="store_true")
    ap.add_argument("--with-icons", action="store_true")
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    print("LOL 皮肤拼图工坊 · 数据流水线")
    print("项目目录: %s" % ROOT)

    if not args.skip_organize:
        if not run("1/3 整理数据（skins.js -> heroes/skins/chromas + 图片索引）", "organize_data.py"):
            return 1

    if not args.no_download:
        if not run("2/3 下载皮肤原画与炫彩图（增量）", "download_images.py",
                   ["--workers", str(args.workers)]):
            return 2
        if args.with_icons:
            run("3/3 下载 60x60 图标（海报背景用）", "download_icons.py")

    print("\n全部完成。打开网页刷新即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
