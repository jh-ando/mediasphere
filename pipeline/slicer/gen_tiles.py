#!/usr/bin/env python3
"""
MediaSphere - 타일 좌표 생성기

평면 그리드(Phase 3 테스트)와 구체 배치(운영)를 같은 tiles.json 스키마로 출력한다.
slice_video.py 는 이 파일만 보고 동작하므로, 레이아웃이 바뀌어도 crop 엔진은 손대지 않는다.

사용 예:
  # Phase 3 - 3행 5열 평면 15분할
  python3 gen_tiles.py flat --cols 5 --rows 3 --source 5400x7020 -o tiles_flat15.json

  # 운영 - 구체 499대 (등장방형 8K 원본)
  python3 gen_tiles.py sphere --source 7680x3840 -o tiles_sphere499.json
"""
import argparse
import json
import math
import sys

# ---------------------------------------------------------------- 기본 상수

# Galaxy A15
PHONE_W_PX, PHONE_H_PX = 1080, 2340
PHONE_DIAG_IN = 6.5
BODY_W_MM, BODY_H_MM = 76.8, 160.1

# 구체 반지름 (mm) - 지름 2m
SPHERE_R_MM = 1000.0

# 구체 위도별 배치: (위도 deg, 대수) - 439대 확정 배치 (CLAUDE.md "폰 배치 (확정)" 참고)
# 위도 높은 순(+64.29 -> -77.14)으로 나열 - deviceId 번호가 이 리스트 순서를 그대로 따라가므로
# (gen_sphere()가 n을 1부터 순차 증가) CLAUDE.md의 "deviceId 번호 규칙"과 일치시키려면
# 반드시 이 순서(북→남)를 유지해야 한다. 남/북 비대칭(−77.14°만 있고 +77.14°는 없음)도 확정값.
SPHERE_ROWS = [
    (64.29, 20),
    (51.43, 30),
    (38.57, 40),
    (25.71, 50),
    (12.86, 50),
    (0.00, 50),
    (-12.86, 50),
    (-25.71, 50),
    (-38.57, 40),
    (-51.43, 30),
    (-64.29, 20),
    (-77.14, 9),
]


def screen_mm():
    """A15 화면 실물 크기(mm) 계산."""
    diag = PHONE_DIAG_IN * 25.4
    ar = PHONE_W_PX / PHONE_H_PX
    h = diag / math.sqrt(1 + ar * ar)
    return h * ar, h


# ---------------------------------------------------------------- 평면 레이아웃

def gen_flat(src_w, src_h, cols, rows, gap_ratio_x, gap_ratio_y, order):
    """
    평면 그리드. 폰 사이 물리적 간격(gap)을 반영해서 crop 영역 사이를 띄운다.
    gap_ratio 0.0 이면 딱 붙은 격자, 0.2 면 셀 피치의 20%가 프레임 간격.
    """
    pitch_w = src_w / cols
    pitch_h = src_h / rows
    tile_w = pitch_w * (1.0 - gap_ratio_x)
    tile_h = pitch_h * (1.0 - gap_ratio_y)

    # 짝수로 맞춰야 H.264/HEVC 인코딩이 안전
    tile_w = int(tile_w) // 2 * 2
    tile_h = int(tile_h) // 2 * 2

    tiles = []
    for r in range(rows):
        for c in range(cols):
            idx = r * cols + c if order == "row" else c * rows + r
            cx = pitch_w * (c + 0.5)
            cy = pitch_h * (r + 0.5)
            x = int(round(cx - tile_w / 2))
            y = int(round(cy - tile_h / 2))
            x = max(0, min(x, src_w - tile_w))
            y = max(0, min(y, src_h - tile_h))
            tiles.append({
                "id": f"P{idx + 1:03d}",
                "x": x, "y": y, "w": tile_w, "h": tile_h,
                "wrap": False,
                "meta": {"row": r, "col": c},
            })
    tiles.sort(key=lambda t: t["id"])
    return tiles


# ---------------------------------------------------------------- 구체 레이아웃

def gen_sphere(src_w, src_h, radius_mm, rows_spec, stagger, margin, front_back=False):
    """
    등장방형 원본에서 각 폰의 위도/경도 구간을 직사각형으로 잘라낸다.

    - 세로: 위도가 픽셀에 선형 대응하므로 모든 폰이 동일한 높이
    - 가로: 위도가 높을수록 경도 폭이 1/cos(lat) 배로 넓어짐
    - 좌우 경계를 넘는 타일은 wrap=True 로 표시 (slice_video.py 가 이어붙임)

    front_back=True면 등장방형이 아니라 "일반 영상 한 장을 전/후면에 미러링해서
    씌우는" 모드다(원본은 1:1 정사각 - main()에서 검증). lon=0을 전면 극,
    lon=180을 후면 극으로 두고 전면([270,360)∪[0,90])은 원본을 그대로,
    후면([90,270])은 mirroredLon=180-lon으로 좌우 반전해서 매핑한다 - lon이
    커질수록 srcX가 반대로 움직이게 만드는 것뿐이라 ffmpeg hflip 없이 crop
    좌표 계산만으로 미러링이 끝난다(CLAUDE.md "전/후면 미러 매핑" 설계 노트 참고).
    두 이음매(lon=90/270)에 정확히 걸치는 소수 타일(439대 배치 기준 8대,
    위도 ±64.29/±38.57)은 절반씩 다른 매핑이 필요한데, 이번 라운드는 단순
    crop 하나로 처리하고 이음매 부분의 미세한 왜곡은 감수하기로 함(실기기
    확인 후 필요하면 등장방형의 wrap 타일처럼 hflip+hstack으로 보정 예정).
    """
    sw_mm, sh_mm = screen_mm()
    sw_mm *= (1.0 + margin)
    sh_mm *= (1.0 + margin)

    ppd_x = src_w / (180.0 if front_back else 360.0)
    ppd_y = src_h / 180.0

    d_lat = math.degrees(sh_mm / radius_mm)
    tile_h = int(round(d_lat * ppd_y)) // 2 * 2

    tiles = []
    n = 0
    for ri, (lat, count) in enumerate(rows_spec):
        cosl = math.cos(math.radians(lat))
        d_lon = math.degrees(sw_mm / (radius_mm * cosl))
        tile_w = int(round(d_lon * ppd_x)) // 2 * 2

        lon_step = 360.0 / count
        lon_off = (lon_step / 2.0) if (stagger and ri % 2) else 0.0

        # gap_lon: 그 행의 경도 간격(lon_step) 대비 폰이 실제로 차지하는 경도 폭(d_lon)
        # 비율 - 텍스트 스크롤이 폰 사이 여백까지 감안해서 흐르게 하는 데 쓴다(flat의
        # gapRatioX와 동일한 개념, 행마다 값이 다름).
        gap_lon = max(0.0, 1.0 - d_lon / lon_step)

        # gap_lat: 이 행에 배정된 세로 각도 폭(위아래 이웃 행과의 거리) 대비 d_lat 비율.
        # 중간 행은 위/아래 이웃까지 거리의 평균(각자 절반씩 배정받는다고 봄), 맨 위/맨
        # 아래 행은 이웃이 한쪽밖에 없어 그 거리를 그대로 씀(위/아래로 똑같이 공간이
        # 있다고 가정하는 근사치 - 실제로 그쪽엔 폰이 없는 빈 공간이 더 있을 수 있지만,
        # 그 구간은 어차피 표시 대상이 아니라 근사로 처리해도 무방하다고 판단).
        if len(rows_spec) == 1:
            lat_spacing = d_lat  # 행이 하나뿐이면 비교 대상이 없음 - gap 0으로 취급
        elif ri == 0:
            lat_spacing = rows_spec[0][0] - rows_spec[1][0]
        elif ri == len(rows_spec) - 1:
            lat_spacing = rows_spec[ri - 1][0] - rows_spec[ri][0]
        else:
            lat_spacing = (rows_spec[ri - 1][0] - rows_spec[ri + 1][0]) / 2.0
        gap_lat = max(0.0, 1.0 - d_lat / lat_spacing) if lat_spacing > 0 else 0.0

        for i in range(count):
            n += 1
            lon = (lon_step * i + lon_off) % 360.0

            if front_back:
                if 90.0 <= lon <= 270.0:
                    local_lon = 180.0 - lon
                    hemisphere = "back"
                else:
                    local_lon = lon if lon <= 90.0 else lon - 360.0
                    hemisphere = "front"
                cx = (local_lon + 90.0) * ppd_x
            else:
                cx = lon * ppd_x

            cy = (90.0 - lat) * ppd_y
            x = int(round(cx - tile_w / 2))
            y = int(round(cy - tile_h / 2))
            y = max(0, min(y, src_h - tile_h))

            if front_back:
                # 전/후면 모드는 등장방형처럼 0도/360도가 같은 지점이 아니라서
                # (이음매는 90/270도, 위 gen_sphere() 독스트링 참고) modulo로
                # 감싸면 안 되고, 화면 범위 안으로 clamp만 한다.
                wrap = False
                x = max(0, min(x, src_w - tile_w))
            else:
                wrap = x < 0 or x + tile_w > src_w
                x = x % src_w

            meta = {
                "row": ri,
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "d_lat": round(d_lat, 4),
                "d_lon": round(d_lon, 4),
                # config.json에서 최종적으로 쓰일 이름과 그대로 맞춰서 저장 -
                # gen_configs.py는 이 값을 복사만 하면 된다.
                "gapRatioX": round(gap_lon, 4),
                "gapRatioY": round(gap_lat, 4),
            }
            if front_back:
                meta["hemisphere"] = hemisphere  # 디버깅/검증용 - Android/서버는 안 씀

            tiles.append({
                "id": f"P{n:03d}",
                "x": x, "y": y, "w": tile_w, "h": tile_h,
                "wrap": wrap,
                "meta": meta,
            })
    return tiles


# ---------------------------------------------------------------- 리포트

def report(tiles, src_w, src_h, out_w, out_h, projection):
    ws = [t["w"] for t in tiles]
    hs = [t["h"] for t in tiles]
    used = sum(w * h for w, h in zip(ws, hs))
    total = src_w * src_h
    print(f"  타일 수        : {len(tiles)}", file=sys.stderr)
    print(f"  원본           : {src_w}x{src_h} ({projection})", file=sys.stderr)
    print(f"  타일 폭        : {min(ws)} ~ {max(ws)} px", file=sys.stderr)
    print(f"  타일 높이      : {min(hs)} ~ {max(hs)} px", file=sys.stderr)
    print(f"  원본 활용률    : {used / total * 100:.1f}%", file=sys.stderr)
    up_w = out_w / min(ws)
    up_h = out_h / min(hs)
    print(f"  최대 확대율    : 가로 {up_w:.1f}배 / 세로 {up_h:.1f}배 "
          f"(출력 {out_w}x{out_h} 기준)", file=sys.stderr)
    if up_w > 4 or up_h > 4:
        print(f"  [!] 확대율이 큽니다. 원본 해상도 상향을 검토하세요.", file=sys.stderr)


# ---------------------------------------------------------------- main

def parse_wh(s):
    w, h = s.lower().split("x")
    return int(w), int(h)


def main():
    ap = argparse.ArgumentParser(description="MediaSphere 타일 좌표 생성기")
    sub = ap.add_subparsers(dest="layout", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--source", metavar="WxH",
                        help="원본 영상 해상도 (예: 5400x7020). "
                             "flat 에서 --pitch 를 쓰면 생략 가능")
    common.add_argument("--output", default=f"{PHONE_W_PX}x{PHONE_H_PX}", metavar="WxH",
                        help=f"폰 출력 해상도 (기본 {PHONE_W_PX}x{PHONE_H_PX})")
    common.add_argument("--fps", type=float, default=30.0)
    common.add_argument("-o", "--out", default="tiles.json")

    f = sub.add_parser("flat", parents=[common], help="평면 그리드")
    f.add_argument("--cols", type=int, default=5)
    f.add_argument("--rows", type=int, default=3)
    f.add_argument("--gap-x", type=float, default=0.0,
                   help="가로 간격 비율 0.0~0.5 (프레임/베젤 보정)")
    f.add_argument("--gap-y", type=float, default=0.0)
    f.add_argument("--order", choices=["row", "col"], default="row",
                   help="ID 부여 순서 (row=행우선)")
    f.add_argument("--pitch", metavar="XxY",
                   help="실측 폰 중심간 거리 mm (예: 125.7x196.3). "
                        "주면 --source 와 --gap 을 자동 계산")
    f.add_argument("--downscale", type=float, default=1.0,
                   help="--pitch 사용 시 네이티브 대비 축소 배수 (예: 3 = 1/3)")

    s = sub.add_parser("sphere", parents=[common], help="구체 배치 (등장방형)")
    s.add_argument("--radius", type=float, default=SPHERE_R_MM, help="구체 반지름 mm")
    s.add_argument("--stagger", action="store_true",
                   help="홀수 행 경도를 절반 어긋나게 배치")
    s.add_argument("--margin", type=float, default=0.0,
                   help="화면 크기 여유율 (0.02 = 2%% 더 크게 crop)")
    s.add_argument("--rows-file", help="위도/대수 JSON 배열 파일 (미지정 시 내장 499대)")
    s.add_argument("--front-back", action="store_true",
                   help="등장방형이 아니라 일반 영상 한 장을 전/후면에 미러링해서 씌우는 "
                        "모드. --source는 1:1 정사각이어야 함(2:1 원본이면 중앙 크롭 후 사용)")

    a = ap.parse_args()
    out_w, out_h = parse_wh(a.output)

    if a.layout == "flat" and a.pitch:
        # 실측 피치(mm) → 원본 해상도 + gap 비율 자동 산출
        sw_mm, sh_mm = screen_mm()
        px_mm, py_mm = (float(v) for v in a.pitch.lower().split("x"))
        if px_mm < sw_mm or py_mm < sh_mm:
            print(f"[!] 피치가 화면보다 작습니다 "
                  f"(화면 {sw_mm:.1f}x{sh_mm:.1f}mm)", file=sys.stderr)
            sys.exit(1)
        ppmm = PHONE_W_PX / sw_mm
        src_w = int(round(px_mm * a.cols * ppmm / a.downscale)) // 2 * 2
        src_h = int(round(py_mm * a.rows * ppmm / a.downscale)) // 2 * 2
        a.gap_x = 1.0 - sw_mm / px_mm
        a.gap_y = 1.0 - sh_mm / py_mm
        shape = "가로형" if src_w > src_h else "세로형"
        print(f"[i] 피치 {px_mm}x{py_mm}mm → 물리 "
              f"{px_mm * a.cols:.0f}x{py_mm * a.rows:.0f}mm ({shape})", file=sys.stderr)
        print(f"[i] 원본 {src_w}x{src_h} / "
              f"gap-x {a.gap_x:.3f} gap-y {a.gap_y:.3f}", file=sys.stderr)
    elif not a.source:
        ap.error("--source 가 필요합니다 (flat 은 --pitch 로 대체 가능)")
    else:
        src_w, src_h = parse_wh(a.source)

    if a.layout == "flat":
        tiles = gen_flat(src_w, src_h, a.cols, a.rows, a.gap_x, a.gap_y, a.order)
        projection = "flat"
    else:
        if a.front_back and src_w != src_h:
            print(f"[!] --front-back은 1:1(정사각) 원본이 필요합니다 (현재 {src_w}x{src_h}). "
                  f"2:1 등장방형 원본이면 --front-back 없이 쓰거나, 먼저 1:1로 중앙 크롭하세요.",
                  file=sys.stderr)
            sys.exit(1)
        rows_spec = SPHERE_ROWS
        if a.rows_file:
            rows_spec = [tuple(r) for r in json.load(open(a.rows_file))]
        tiles = gen_sphere(src_w, src_h, a.radius, rows_spec, a.stagger, a.margin, a.front_back)
        projection = "frontback-mirror" if a.front_back else "equirect"

    # gap: 폰 화면 대비 실제 물리 간격(피치) 비율. 텍스트 스크롤이 폰 사이 여백까지
    # 감안해서 흐르게 하는 데 쓴다(가로/세로 각 0.0=간격 없음 ~ 값이 클수록 넓은 간격).
    # flat은 --pitch로 실측해서 산출하지만, sphere는 위도별로 폰 개수/간격이 달라
    # "피치 하나"로 못 잡는다 - 위도별 gap_lon = 1 - d_lon/(360/count), gap_lat = 1 -
    # d_lat/(행간 위도차) 식으로 행마다 따로 계산해야 하는데, 이번 라운드는 평면(flat)
    # 텍스트 스크롤 간격 보정까지만 구현하고 sphere는 0으로 남겨둔다(추후 과제).
    gap = {"x": a.gap_x, "y": a.gap_y} if a.layout == "flat" else {"x": 0.0, "y": 0.0}

    doc = {
        "version": 1,
        "layout": a.layout,
        "source": {"width": src_w, "height": src_h, "projection": projection},
        "output": {"width": out_w, "height": out_h, "fps": a.fps},
        "gap": gap,
        "tiles": tiles,
    }
    with open(a.out, "w", encoding="utf-8") as fp:
        json.dump(doc, fp, indent=2, ensure_ascii=False)

    print(f"[OK] {a.out}", file=sys.stderr)
    report(tiles, src_w, src_h, out_w, out_h, projection)


if __name__ == "__main__":
    main()
