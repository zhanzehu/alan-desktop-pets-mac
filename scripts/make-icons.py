#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成托盘图标（template PNG）与应用图标。

托盘图标用纯 alpha 形状（macOS Template Image：只取 alpha 当遮罩，自动适配深浅色菜单栏）。
应用图标直接把邵艾伦的脸裁成圆角方形，交给 sips 生成 .icns。
"""

import math
import os
import struct
import subprocess
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, "build")


def write_png(path, width, height, pixels):
    """pixels: list of rows, each row list of (r,g,b,a)"""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def bubble_alpha(size):
    """一个对话气泡：圆角矩形 + 左下小尾巴 + 三个洞（洞是透明的）。"""
    scale = size / 22.0
    rows = []
    # 气泡主体（22pt 坐标系）
    bx0, by0, bx1, by1 = 1.0, 2.0, 21.0, 15.0
    radius = 4.0
    # 尾巴三角
    tail = [(5.0, 14.5), (5.0, 20.2), (10.0, 14.5)]
    # 三个圆点洞
    dots = [(6.0, 8.4), (11.0, 8.4), (16.0, 8.4)]
    dot_r = 1.35

    sub = 3  # 3x3 超采样，边缘更干净
    for py in range(size):
        row = []
        for px in range(size):
            covered = 0
            for sy in range(sub):
                for sx in range(sub):
                    x = (px + (sx + 0.5) / sub) / scale
                    y = (py + (sy + 0.5) / sub) / scale
                    hit = inside_round_rect(x, y, bx0, by0, bx1, by1, radius)
                    if not hit:
                        # 尾巴：点在三角形内
                        ax, ay = tail[0]
                        bx, by = tail[1]
                        cx, cy = tail[2]
                        d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
                        d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
                        d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
                        neg = d1 < 0 or d2 < 0 or d3 < 0
                        pos = d1 > 0 or d2 > 0 or d3 > 0
                        hit = not (neg and pos)
                    if hit:
                        for dx, dy in dots:
                            if (x - dx) ** 2 + (y - dy) ** 2 <= dot_r * dot_r:
                                hit = False
                                break
                    if hit:
                        covered += 1
            a = int(round(255 * covered / (sub * sub)))
            row.append((0, 0, 0, a))
        rows.append(row)
    return rows


def make_tray():
    for size, suffix in ((22, ""), (44, "@2x")):
        write_png(
            os.path.join(BUILD, "trayTemplate%s.png" % suffix),
            size,
            size,
            bubble_alpha(size),
        )
        print("tray icon:", size, "px")


def make_app_icon():
    src = os.path.join(ROOT, "assets", "shaolan", "face.png")
    if not os.path.exists(src):
        print("跳过应用图标：找不到 assets/shaolan/face.png")
        return

    iconset = os.path.join(BUILD, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)

    base = os.path.join(BUILD, "icon-base.png")
    subprocess.run(["sips", "-s", "format", "png", "-z", "1024", "1024", src, "--out", base],
                   check=True, stdout=subprocess.DEVNULL)

    for px in (16, 32, 64, 128, 256, 512):
        for scale, tag in ((1, ""), (2, "@2x")):
            out = os.path.join(iconset, "icon_%dx%d%s.png" % (px, px, tag))
            subprocess.run(["sips", "-z", str(px * scale), str(px * scale), base, "--out", out],
                           check=True, stdout=subprocess.DEVNULL)

    icns = os.path.join(BUILD, "icon.icns")
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns],
                   check=True, stdout=subprocess.DEVNULL)

    # 同时留一份 512 PNG 给 electron-builder 兜底
    subprocess.run(["sips", "-z", "512", "512", base, "--out", os.path.join(BUILD, "icon.png")],
                   check=True, stdout=subprocess.DEVNULL)
    print("app icon: build/icon.icns")


if __name__ == "__main__":
    make_tray()
    make_app_icon()
