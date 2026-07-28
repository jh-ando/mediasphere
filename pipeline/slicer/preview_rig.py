#!/usr/bin/env python3
"""
tiles.json + 원본 프레임 → 실제 리그 배치 목업 이미지

폰 사이 간격까지 반영해서, 15대를 실제로 세웠을 때 어떻게 보이는지 미리 확인한다.
"""
import json
import sys
from PIL import Image

def build(src_png, tiles_json, out_png, tile_w=132, fit="crop", bg=(18, 18, 18)):
    doc = json.load(open(tiles_json))
    src = doc["source"]
    out_w, out_h = doc["output"]["width"], doc["output"]["height"]

    im = Image.open(src_png).convert("RGB")

    # slice_video.py 와 동일한 전처리
    target = src["width"] / src["height"]
    iw, ih = im.size
    if abs(iw / ih - target) / target >= 0.01:
        if fit == "crop":
            if iw / ih > target:
                cw, ch = int(round(ih * target)), ih
            else:
                cw, ch = iw, int(round(iw / target))
            cx, cy = (iw - cw) // 2, (ih - ch) // 2
            im = im.crop((cx, cy, cx + cw, cy + ch))
    im = im.resize((src["width"], src["height"]), Image.LANCZOS)

    tiles = doc["tiles"]
    cols = max(t["meta"]["col"] for t in tiles) + 1
    rows = max(t["meta"]["row"] for t in tiles) + 1

    t0 = tiles[0]
    tile_h = int(round(tile_w * out_h / out_w))
    # 실제 간격 비율 반영
    pitch_x = int(round(tile_w / (t0["w"] / (src["width"] / cols))))
    pitch_y = int(round(tile_h / (t0["h"] / (src["height"] / rows))))
    gx = (pitch_x - tile_w) // 2
    gy = (pitch_y - tile_h) // 2

    canvas = Image.new("RGB", (pitch_x * cols, pitch_y * rows), bg)
    for t in tiles:
        piece = im.crop((t["x"], t["y"], t["x"] + t["w"], t["y"] + t["h"]))
        piece = piece.resize((tile_w, tile_h), Image.LANCZOS)
        c, r = t["meta"]["col"], t["meta"]["row"]
        canvas.paste(piece, (pitch_x * c + gx, pitch_y * r + gy))

    canvas.save(out_png)
    print(f"{out_png}  {canvas.size[0]}x{canvas.size[1]}  "
          f"(타일 {t0['w']}x{t0['h']} → 표시 {tile_w}x{tile_h})")


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2], sys.argv[3],
          tile_w=int(sys.argv[4]) if len(sys.argv) > 4 else 132,
          fit=sys.argv[5] if len(sys.argv) > 5 else "crop")
