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
채워넣는 값). 텍스트 스크롤 기능이 "나는 전체 배너 중 어느 위치를 보여줘야
하는지" 계산하는 데 쓴다 - sphere처럼 meta에 row/col이 없는 레이아웃이면
그냥 생략된다.

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
        if "colorOverlayAlpha" in base:
            config["colorOverlayAlpha"] = base["colorOverlayAlpha"]

        out_path = os.path.join(a.outdir, f"{device_id}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        count += 1

    print(f"[OK] {os.path.abspath(a.outdir)} - config.json {count}개 생성")


if __name__ == "__main__":
    main()
