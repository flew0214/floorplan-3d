#!/usr/bin/env python3
"""floorplan-3d 启动器 —— 起一个本地静态服务器并打开浏览器。

用法:
    python start.py            # 默认端口 8123
    python start.py 9000       # 指定端口

为什么需要它:
    浏览器在 file:// 下把每个 file: 文档当作独立源，会用 CORS 策略禁止
    file->file 的 ES module 导入（本地 vendor/three 也一样被拦），因此
    双击 index.html 只能看 2D 平面图，3D 场景加载不出来。
    通过 http:// 打开则一切正常，且 three.js 走本地 vendor、完全离线。
"""

import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 保持输出干净


def pick_port(start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"端口 {start}-{start + 49} 都被占用了，请用 python start.py <端口> 指定其它端口")


def main() -> None:
    port = pick_port(int(sys.argv[1]) if len(sys.argv) > 1 else 8123)
    url = f"http://127.0.0.1:{port}/index.html"

    print("floorplan-3d 已启动")
    print(f"  地址: {url}")
    print("  按 Ctrl+C 停止服务")
    print()

    threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
