# -*- coding: utf-8 -*-
"""
本地静态服务器（零依赖）。

为什么需要它：
  - file:// 下浏览器会用 CORS 策略拦掉 fetch()，数据读不出来
  - file:// 下 canvas 被"污染"(tainted)，导出 PNG 会抛 SecurityError

用法:
  python tools/serve.py                 # 默认 http://127.0.0.1:8777/web/
  python tools/serve.py --port 9000
  python tools/serve.py --no-browser
"""
import argparse
import os
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
    })

    def end_headers(self):
        # 开发期禁用缓存：否则改完 js 浏览器还在跑旧文件，排查会被严重误导
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, fmt, *args):
        # --verbose 时才记录图片请求（拼图一次会拉几百张，刷屏）
        if self.server.verbose:
            sys.stderr.write("  %s %s\n" % (self.command, self.path))
            return
        if not self.path.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')):
            sys.stderr.write("  %s %s\n" % (self.command, self.path))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8777)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--verbose', action='store_true', help='记录每一个图片请求（排查拼图卡住时用）')
    args = ap.parse_args()

    handler = partial(Handler, directory=ROOT)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    httpd.verbose = args.verbose
    url = 'http://%s:%d/web/' % (args.host, args.port)

    n_img = 0
    img_dir = os.path.join(ROOT, 'images')
    if os.path.isdir(img_dir):
        for _, _, files in os.walk(img_dir):
            n_img += len(files)

    print('LOL 皮肤拼图工坊')
    print('  服务目录 : %s' % ROOT)
    print('  本地图片 : %d 张' % n_img)
    print('  访问地址 : %s' % url)
    print('  停止服务 : Ctrl+C\n')

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
