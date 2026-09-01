#!/usr/bin/env python3
"""
MediaSphere - 폰별 config.json 생성기

gen_manifest.py 가 만든 배포 매니페스트(devices 배열)와, 전 폰 공통값을 담은
base-config.json 을 합쳐서 android/config.json 과 동일한 스키마로 폰별
configs/{deviceId}.json 을 찍어낸다. 필드는 android/MainActivity.kt,
MqttManager.kt, TimeSyncManager.kt 가 실제로 읽는 것만 채운다
(deviceId, ssid, serverIp, multicastGroup, timecodePort, mqttBroker,
videoPath, currentVideo, checksum, row/col(선택), colorOverlayAlpha(선택)).

row/col은 device["meta"]에서 그대로 가져온다(gen_tiles.py의 flat 레이아웃이
채워넣는 값). lat/lon도 있으면 그대로 가져온다(sphere 레이아웃 전용). 텍스트
스크롤 기능이 "나는 전체 배너 중 어느 위치를 보여줘야 하는지" 계산하는 데
쓴다 - flat은 row/col(균일 격자 인덱스), sphere는 lat/lon(연속 각도) 기준으로
Android TextScrollView.kt가 분기해서 계산한다.

gapRatioX/gapRatioY는 레이아웃에 따라 출처가 다르다:
- flat: manifest["gap"](gen_tiles.py가 --pitch 실측값으로 계산, 모든 폰 공통값)
- sphere: device["meta"]["gapRatioX"/"gapRatioY"](gen_tiles.py가 행마다 다르게
  계산 - 위도별로 폰 개수/간격이 달라 공통값 하나로 못 잡음)
폰마다 다를 수 있는 sphere 쪽을 우선 확인하고, 없으면 flat의 공통값으로 fallback.
텍스트 스크롤이 폰 화면 폭/높이만으로 캔버스를 이어붙이면 실제 폰 사이 물리적
간격(베젤+거치대)이 반영 안 돼서 글자가 압축돼 보이는 문제를 이 비율로 보정한다.
0이면 간격 없음.

checksum은 폰이 로컬에 이미 있는 동일 파일명(예: P001.mp4)을 무조건 "맞다"고
믿지 않고, 기대 체크섬과 비교해서 다르면 재다운로드하게 하는 데 쓰인다 -
서버만 새로 배포하고 폰의 기존 파일은 그대로 남아있는 상황(체크섬은 바뀌었는데
파일명은 같은 경우)에서 재다운로드가 안 되는 문제를 막기 위함.

base-config.json 예시는 base-config.example.json 참고.

사용 예:
  python3 gen_configs.py -i distribute/manifest.json \
      --base-config base-config.example.json -o distribute/configs/
"""
import argparse
import json
import os

REQUIRED_BASE_FIELDS = [
    "serverIp", "multicastGroup", "timecodePort", "mqttBroker", "videoPath",
]


def main():
    ap = argparse.ArgumentParser(description="MediaSphere 폰별 config.json 생성기")
    ap.add_argument("-i", "--input", required=True,
                     help="gen_manifest.py가 만든 배포 manifest.json 경로")
    ap.add_argument("--base-config", required=True,
                     help="전 폰 공통값 JSON (serverIp/multicastGroup/timecodePort/"
                          "mqttBroker/videoPath, colorOverlayAlpha는 선택)")
    ap.add_argument("-o", "--outdir", default="distribute/configs")
    a = ap.parse_args()

    manifest = json.load(open(a.input, encoding="utf-8"))
    base = json.load(open(a.base_config, encoding="utf-8"))

    missing = [k for k in REQUIRED_BASE_FIELDS if k not in base]
    if missing:
        raise SystemExit(f"[!] base-config에 누락된 필드: {', '.join(missing)}")

    os.makedirs(a.outdir, exist_ok=True)

    gap = manifest.get("gap", {"x": 0.0, "y": 0.0})

    count = 0
    for device in manifest["devices"]:
        device_id = device["deviceId"]
        if not device.get("ssid"):
            print(f"[!] deviceId={device_id} SSID 미배정 - 스킵 "
                  f"(gen_manifest.py --ap-count 확인)")
            continue

        config = {
            "deviceId": device_id,
            "ssid": device["ssid"],
            "serverIp": base["serverIp"],
            "multicastGroup": base["multicastGroup"],
            "timecodePort": base["timecodePort"],
            "mqttBroker": base["mqttBroker"],
            "videoPath": base["videoPath"],
            "currentVideo": device["tileId"],
        }
        if device.get("checksum"):
            config["checksum"] = device["checksum"]
        meta = device.get("meta", {})
        if "row" in meta:
            config["row"] = meta["row"]
        if "col" in meta:
            config["col"] = meta["col"]
        if "lat" in meta:
            config["lat"] = meta["lat"]
        if "lon" in meta:
            config["lon"] = meta["lon"]
        if "gapRatioX" in meta and "gapRatioY" in meta:
            # sphere: 폰(행)마다 다른 값 - 매니페스트 공통값보다 우선
            config["gapRatioX"] = meta["gapRatioX"]
            config["gapRatioY"] = meta["gapRatioY"]
        elif gap.get("x") or gap.get("y"):
            # flat: 매니페스트 전체 공통값
            config["gapRatioX"] = gap.get("x", 0.0)
            config["gapRatioY"] = gap.get("y", 0.0)
        if "colorOverlayAlpha" in base:
            config["colorOverlayAlpha"] = base["colorOverlayAlpha"]

        out_path = os.path.join(a.outdir, f"{device_id}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        count += 1

    print(f"[OK] {os.path.abspath(a.outdir)} - config.json {count}개 생성")


if __name__ == "__main__":
    main()
