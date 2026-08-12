#!/usr/bin/env python3
"""
MediaSphere - 배포 매니페스트 생성기

slice_video.py 가 출력한 slice_manifest.json(files 배열)을 입력받아,
폰별 deviceId/SSID/체크섬을 채운 배포용 manifest.json을 만든다.
이 출력은 gen_configs.py 의 입력이자, 서버가 파일 수신 검증에 쓰는
"기대값" 원본이 된다.

주의: 입력(slice_manifest.json)과 출력(manifest.json)은 이름이 다른 별개 파일이다.
서버(server.js)가 실제로 읽는 건 이 스크립트의 출력물(-o로 지정한 경로)뿐이다 -
slice_video.py의 slice_manifest.json만 있고 이 스크립트를 안 돌리면 서버는
배포 대상이 없는 것으로 취급한다. 세 단계를 한 번에 실행하려면 deploy.py를 쓴다.

사용 예:
  python3 gen_manifest.py -i out/slice_manifest.json --ap-count 15 -o distribute/manifest.json
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys

CHUNK_SIZE = 1024 * 1024  # 체크섬 계산 시 1MB씩 읽는다 (대용량 영상 파일 메모리 절약)


def parse_device_id(tile_id):
    """타일 id(예: "P047")에서 정수 deviceId를 뽑는다."""
    m = re.search(r"\d+", tile_id)
    if not m:
        raise ValueError(f"타일 id에서 숫자를 찾을 수 없습니다: {tile_id}")
    return int(m.group())


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def assign_ssids(devices, ap_count):
    """
    deviceId 순서(=물리적 배치 순서)를 그대로 ap_count개의 연속 블록으로 나눠
    SSID(MEDIA_01, MEDIA_02, ...)를 배정한다.

    라운드로빈이 아니라 연속 블록을 쓰는 이유: 물리적으로 인접한 폰들이
    같은 AP 근처에 있을 가능성이 높으므로, 인접 구간을 통째로 한 AP에
    몰아주는 편이 실제 설치 현장의 AP 배치와 맞아떨어진다.
    """
    total = len(devices)
    if ap_count < 1:
        raise ValueError("--ap-count는 1 이상이어야 합니다.")
    if ap_count > total:
        print(f"[!] AP 수({ap_count})가 디바이스 수({total})보다 많습니다. "
              f"일부 AP는 담당 디바이스가 없습니다.", file=sys.stderr)

    base, remainder = divmod(total, ap_count)
    idx = 0
    for ap_idx in range(ap_count):
        block_size = base + (1 if ap_idx < remainder else 0)
        ssid = f"MEDIA_{ap_idx + 1:02d}"
        for _ in range(block_size):
            if idx >= total:
                break
            devices[idx]["ssid"] = ssid
            idx += 1


def main():
    ap = argparse.ArgumentParser(description="MediaSphere 배포 매니페스트 생성기")
    ap.add_argument("-i", "--input", required=True,
                     help="slice_video.py가 출력한 slice_manifest.json 경로")
    ap.add_argument("--ap-count", type=int, required=True,
                     help="현장 AP(SSID) 대수. 폰을 이 수만큼 연속 블록으로 균등 분배")
    ap.add_argument("-o", "--out", default="distribute/manifest.json")
    ap.add_argument("--skip-checksum", action="store_true",
                     help="체크섬 계산 생략 (영상 파일이 아직 없는 --dry-run 검증용)")
    a = ap.parse_args()

    src_manifest = json.load(open(a.input, encoding="utf-8"))
    video_dir = os.path.dirname(os.path.abspath(a.input))

    devices = []
    for entry in src_manifest["files"]:
        tile_id = entry["id"]
        device_id = parse_device_id(tile_id)
        video_path = os.path.join(video_dir, entry["file"])

        checksum = None
        if not a.skip_checksum:
            if not os.path.isfile(video_path):
                print(f"[!] 영상 파일 없음, 체크섬 생략: {video_path}", file=sys.stderr)
            else:
                checksum = "sha256:" + sha256_of(video_path)

        devices.append({
            "deviceId": device_id,
            "tileId": tile_id,
            "ssid": None,  # assign_ssids에서 채움
            "videoFile": entry["file"],
            "checksum": checksum,
            "meta": entry.get("meta", {}),
        })

    devices.sort(key=lambda d: d["deviceId"])
    assign_ssids(devices, a.ap_count)

    doc = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "layout": src_manifest["layout"],
        "apCount": a.ap_count,
        "devices": devices,
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)

    print(f"[OK] {a.out} - 디바이스 {len(devices)}대, AP {a.ap_count}대", file=sys.stderr)


if __name__ == "__main__":
    main()
