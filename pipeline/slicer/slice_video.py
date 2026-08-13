#!/usr/bin/env python3
"""
MediaSphere - 영상 분할기

tiles.json 을 읽어서 원본 영상을 폰 대수만큼 잘라낸다.
평면/구체 구분 없이 동일하게 동작한다 (좌표 생성은 gen_tiles.py 담당).

사용 예:
  # 평면 15분할
  python3 slice_video.py -i master.mp4 -t tiles_flat15.json -o out/

  # NVENC 하드웨어 인코딩 (RTX 5060 Ti)
  python3 slice_video.py -i master.mp4 -t tiles.json -o out/ --encoder hevc_nvenc

  # 원본 해상도가 tiles.json 과 다를 때 자동 스케일
  python3 slice_video.py -i master_4k.mp4 -t tiles_8k.json -o out/ --prescale lanczos

  # 미리보기: 실제 인코딩 없이 명령만 출력
  python3 slice_video.py -i master.mp4 -t tiles.json -o out/ --dry-run
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed


def probe(path):
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
           "-of", "json", path]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    st = json.loads(out)["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    return {"width": st["width"], "height": st["height"],
            "fps": float(num) / float(den)}


def build_filter(tile, src_w, out_w, out_h, prescale, scale_flags):
    """
    한 타일에 대한 filter_complex 문자열을 만든다.
    wrap 타일(경도 0도 경계를 넘는 경우)은 좌우 두 조각을 이어붙인다.
    """
    pre = f"{prescale}," if prescale else ""
    x, y, w, h = tile["x"], tile["y"], tile["w"], tile["h"]

    if tile.get("wrap"):
        w1 = min(w, src_w - x)
        w2 = w - w1
        f = (f"[0:v]{pre}split=2[a][b];"
             f"[a]crop={w1}:{h}:{x}:{y}[l];"
             f"[b]crop={w2}:{h}:0:{y}[r];"
             f"[l][r]hstack=inputs=2,"
             f"scale={out_w}:{out_h}:flags={scale_flags},setsar=1[v]")
    else:
        f = (f"[0:v]{pre}crop={w}:{h}:{x}:{y},"
             f"scale={out_w}:{out_h}:flags={scale_flags},setsar=1[v]")
    return f


def build_cmd(args, tile, src_w, out_w, out_h, prescale, dst):
    vf = build_filter(tile, src_w, out_w, out_h, prescale, args.scale_flags)
    if getattr(args, "retime", None):
        vf = vf.replace("[v]", f",setpts={args.retime:.9f}*PTS[v]")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-i", args.input,
           "-filter_complex", vf, "-map", "[v]"]

    if args.audio:
        cmd += ["-map", "0:a?", "-c:a", "aac", "-b:a", "128k"]
    else:
        cmd += ["-an"]

    if getattr(args, "target_fps", None):
        cmd += ["-r", f"{args.target_fps:g}"]

    cmd += ["-c:v", args.encoder]
    if "nvenc" in args.encoder:
        cmd += ["-preset", args.nvenc_preset, "-rc", "vbr",
                "-cq", str(args.quality), "-b:v", "0"]
    else:
        cmd += ["-preset", args.x26x_preset, "-crf", str(args.quality)]

    cmd += ["-pix_fmt", "yuv420p",
            "-g", str(args.gop),
            "-movflags", "+faststart",
            dst]
    return cmd


def tile_output_size(mode, tile, out_w, out_h):
    """--output-size 에 따라 이 타일의 인코딩 해상도를 정한다."""
    if mode == "tiles":
        return out_w, out_h
    if mode == "fit":
        # 폰 화면 비율은 유지하되, 타일 원본보다 작아지지 않는 최소 크기
        h = max(tile["h"], round(tile["w"] * out_h / out_w))
        h = int(h) // 2 * 2
        w = int(round(h * out_w / out_h)) // 2 * 2
        return max(w, 2), max(h, 2)
    w, h = (int(v) for v in mode.lower().split("x"))
    return w, h


def main():
    ap = argparse.ArgumentParser(description="MediaSphere 영상 분할기")
    ap.add_argument("-i", "--input", required=True, help="원본 영상")
    ap.add_argument("-t", "--tiles", required=True, help="tiles.json")
    ap.add_argument("-o", "--outdir", required=True, help="출력 폴더")
    ap.add_argument("-j", "--jobs", type=int, default=4, help="동시 인코딩 수")
    ap.add_argument("--encoder", default="libx264",
                    help="libx264 | libx265 | h264_nvenc | hevc_nvenc")
    ap.add_argument("--quality", type=int, default=20, help="CRF/CQ 값 (낮을수록 고화질)")
    ap.add_argument("--x26x-preset", default="medium")
    ap.add_argument("--nvenc-preset", default="p4")
    ap.add_argument("--gop", type=int, default=30,
                    help="키프레임 간격. 동기화 seek 정확도에 영향")
    ap.add_argument("--scale-flags", default="lanczos")
    ap.add_argument("--fps", default="auto",
                    help="auto = tiles.json 프레임레이트로 리타이밍 (기본). "
                         "source = 원본 그대로 둠")
    ap.add_argument("--output-size", default="tiles",
                    help="tiles = tiles.json 값 그대로 (기본, 1080x2340). "
                         "fit = 타일 원본 크기로 인코딩하고 폰이 확대. "
                         "또는 WxH 직접 지정")
    ap.add_argument("--prescale", nargs="?", const="auto", default="auto",
                    help="스케일 목표 해상도. 기본 auto = tiles.json 해상도")
    ap.add_argument("--fit", choices=["crop", "stretch"], default="crop",
                    help="원본 비율이 다를 때 처리. "
                         "crop=잘라서 맞춤(기본), stretch=늘려서 맞춤(왜곡)")
    ap.add_argument("--anchor", default="center",
                    choices=["center", "top", "bottom", "left", "right"],
                    help="crop 기준 위치 (기본 center)")
    ap.add_argument("--audio", action="store_true", help="오디오 포함 (기본 제외)")
    ap.add_argument("--only", help="특정 타일만 처리 (쉼표 구분, 예: P001,P008)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    doc = json.load(open(a.tiles, encoding="utf-8"))
    tiles = doc["tiles"]
    src = doc["source"]
    out_w = doc["output"]["width"]
    out_h = doc["output"]["height"]

    if a.only:
        keep = set(s.strip() for s in a.only.split(","))
        tiles = [t for t in tiles if t["id"] in keep]

    info = probe(a.input)
    prescale = None
    if info["width"] != src["width"] or info["height"] != src["height"]:
        if a.prescale == "auto":
            tw, th = src["width"], src["height"]
        else:
            tw, th = (int(v) for v in a.prescale.lower().split("x"))

        chain = []
        if a.fit == "crop":
            target = tw / th
            iw, ih = info["width"], info["height"]
            if abs(iw / ih - target) / target < 0.01:
                pass
            else:
                if iw / ih > target:
                    cw, ch = int(round(ih * target)) // 2 * 2, ih
                else:
                    cw, ch = iw, int(round(iw / target)) // 2 * 2
                if a.anchor == "left":
                    cx, cy = 0, (ih - ch) // 2
                elif a.anchor == "right":
                    cx, cy = iw - cw, (ih - ch) // 2
                elif a.anchor == "top":
                    cx, cy = (iw - cw) // 2, 0
                elif a.anchor == "bottom":
                    cx, cy = (iw - cw) // 2, ih - ch
                else:
                    cx, cy = (iw - cw) // 2, (ih - ch) // 2
                chain.append(f"crop={cw}:{ch}:{cx}:{cy}")
                lost = 100 * (1 - (cw * ch) / (iw * ih))
                print(f"[i] 비율 보정 crop {iw}x{ih} → {cw}x{ch} "
                      f"({a.anchor} 기준, 화면의 {lost:.1f}% 잘림)")
        chain.append(f"scale={tw}:{th}:flags={a.scale_flags}")
        prescale = ",".join(chain)
        print(f"[i] 원본 {info['width']}x{info['height']} → {tw}x{th} "
              f"({a.fit}, {a.scale_flags})")

    os.makedirs(a.outdir, exist_ok=True)

    # 프레임레이트 정합 — 타임코드가 30fps 고정이라 원본이 29.97 이면 계속 어긋난다
    a.retime = None
    a.target_fps = None
    if a.fps != "source":
        tgt = doc["output"]["fps"] if a.fps == "auto" else float(a.fps)
        ratio = info["fps"] / tgt
        if abs(ratio - 1.0) > 0.0005:
            a.retime = ratio
            a.target_fps = tgt
            print(f"[i] 프레임레이트 {info['fps']:.3f} → {tgt:g} 리타이밍 "
                  f"(재생 속도 {(1 / ratio - 1) * 100:+.2f}%, 프레임 중복/누락 없음)")
        elif abs(info["fps"] - tgt) > 1e-6:
            a.target_fps = tgt

    sizes = {t["id"]: tile_output_size(a.output_size, t, out_w, out_h) for t in tiles}
    uniq = sorted(set(sizes.values()))
    desc = (f"{uniq[0][0]}x{uniq[0][1]}" if len(uniq) == 1
            else f"{len(uniq)}종 ({uniq[0][0]}x{uniq[0][1]} ~ {uniq[-1][0]}x{uniq[-1][1]})")
    print(f"[i] 타일 {len(tiles)}개 / 출력 {desc} / "
          f"인코더 {a.encoder} / 동시 {a.jobs}개")

    jobs = []
    for t in tiles:
        dst = os.path.join(a.outdir, f"{t['id']}.mp4")
        tw, th = sizes[t["id"]]
        jobs.append((t, build_cmd(a, t, src["width"], tw, th, prescale, dst), dst))

    if a.dry_run:
        for t, cmd, dst in jobs:
            print(" ".join(shlex.quote(c) for c in cmd))
        return

    t0 = time.time()
    done = 0
    failed = []
    with ThreadPoolExecutor(max_workers=a.jobs) as ex:
        futs = {ex.submit(subprocess.run, cmd, capture_output=True, text=True): (t, dst)
                for t, cmd, dst in jobs}
        for fu in as_completed(futs):
            tile, dst = futs[fu]
            r = fu.result()
            done += 1
            if r.returncode != 0:
                failed.append(tile["id"])
                print(f"  [FAIL] {tile['id']}: {r.stderr.strip()[:200]}")
            else:
                sz = os.path.getsize(dst) / 1024 / 1024
                print(f"  [{done}/{len(jobs)}] {tile['id']}.mp4  {sz:.1f}MB")

    el = time.time() - t0
    print(f"\n[완료] {len(jobs) - len(failed)}/{len(jobs)} · {el:.1f}초")
    if failed:
        print(f"[실패] {', '.join(failed)}")
        sys.exit(1)

    # 폰 배포용 매니페스트
    man = {
        "layout": doc["layout"],
        "output": doc["output"],
        "gap": doc.get("gap", {"x": 0.0, "y": 0.0}),  # gen_tiles.py가 계산한 폰 간격 비율 - 그대로 다음 단계로 전달
        "files": [{"id": t["id"], "file": f"{t['id']}.mp4",
                   "width": sizes[t["id"]][0], "height": sizes[t["id"]][1],
                   "meta": t.get("meta", {})} for t in tiles],
    }
    # gen_manifest.py 최종 산출물과 이름이 같으면 헷갈리므로(둘 다 "manifest.json"이면
    # distribute/manifest.json이 없는데 videos/manifest.json만 있는 걸 최종본으로 착각하기 쉽다)
    # slice_manifest.json으로 구분한다. 이 파일이 gen_manifest.py -i 의 입력이다.
    mp = os.path.join(a.outdir, "slice_manifest.json")
    json.dump(man, open(mp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"[i] {mp} 생성 - gen_manifest.py 입력으로 사용")


if __name__ == "__main__":
    main()
