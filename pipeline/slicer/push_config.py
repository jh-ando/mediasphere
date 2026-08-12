#!/usr/bin/env python3
"""
MediaSphere - 폰에 config.json 최초 수동 푸시 (부트스트랩 전용)

gen_configs.py가 만든 configs/{deviceId}.json을 adb로 연결된 폰의
/sdcard/mediasphere/config.json에 그대로 밀어넣는다. deviceId/currentVideo가
이미 정답값(예: P047)으로 채워진 실제 배포 파일을 쓰는 것이므로,
직접 손으로 "v1" 같은 임시값을 적어넣지 않아도 된다.

이건 최초 1회(폰에 앱은 깔려 있지만 config.json이 아직 없거나 다른 폰 것인
경우) 부트스트랩용이다. 이후 재배포는 wall/device(MQTT)로 자동 처리된다 -
매번 이 스크립트를 돌릴 필요 없음.

사용 예:
  # 폰 1대만 연결된 경우
  python3 push_config.py 47

  # 여러 대 중 특정 1대만 지정
  python3 push_config.py 47 --serial R58N123ABCD

  # 여러 대를 한 번에, deviceId 100부터 순서대로 배정
  python3 push_config.py --sequential --start-id 100

  # 연결된 adb 기기 목록만 확인
  python3 push_config.py --list
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIGS_DIR = os.path.join(HERE, "..", "..", "server", "distribute", "configs")
DEVICE_DIR = "/sdcard/mediasphere"
DEVICE_CONFIG_PATH = f"{DEVICE_DIR}/config.json"


def adb(args, serial=None, check=True):
    cmd = ["adb"]
    if serial:
        cmd += ["-s", serial]
    cmd += args
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def connected_serials():
    result = adb(["devices"], check=False)
    return [
        line.split("\t")[0]
        for line in result.stdout.splitlines()[1:]
        if line.strip() and line.endswith("\tdevice")
    ]


def list_devices():
    result = adb(["devices", "-l"], check=False)
    lines = [line for line in result.stdout.splitlines()[1:] if line.strip()]
    if not lines:
        print("[!] 연결된 adb 기기가 없습니다.", file=sys.stderr)
        return
    print("연결된 기기:", file=sys.stderr)
    for line in lines:
        print(f"  {line}", file=sys.stderr)


def resolve_serial(explicit_serial):
    serials = connected_serials()

    if explicit_serial:
        if explicit_serial not in serials:
            print(f"[!] {explicit_serial} 가 연결된 기기 목록에 없습니다: {serials}", file=sys.stderr)
            sys.exit(1)
        return explicit_serial

    if not serials:
        print("[!] 연결된 adb 기기가 없습니다 ('adb devices'로 확인하세요).", file=sys.stderr)
        sys.exit(1)
    if len(serials) > 1:
        print(f"[!] 기기가 여러 대 연결돼 있습니다: {serials}", file=sys.stderr)
        print("    --serial 로 하나를 지정하거나 --sequential 로 한 번에 배정하세요.",
              file=sys.stderr)
        sys.exit(1)
    return serials[0]


# 한 기기에 config.json 하나를 push하고, 실제로 들어간 내용을 다시 읽어 deviceId가
# 일치하는지 확인한다 (사고 조기 발견용). 성공하면 True.
def push_one(serial, device_id, configs_dir):
    config_path = os.path.join(configs_dir, f"{device_id}.json")
    if not os.path.isfile(config_path):
        print(f"  [!] {serial} -> deviceId={device_id}: {config_path} 없음", file=sys.stderr)
        return False

    adb(["shell", "mkdir", "-p", DEVICE_DIR], serial=serial)
    adb(["push", config_path, DEVICE_CONFIG_PATH], serial=serial)

    verify = adb(["shell", "cat", DEVICE_CONFIG_PATH], serial=serial, check=False)
    try:
        pushed = json.loads(verify.stdout)
    except (json.JSONDecodeError, ValueError):
        pushed = None

    if pushed and pushed.get("deviceId") == device_id:
        print(f"  [OK] {serial} -> deviceId={device_id} ssid={pushed.get('ssid')} "
              f"currentVideo={pushed.get('currentVideo')}", file=sys.stderr)
        return True

    print(f"  [!] {serial} -> deviceId={device_id}: 푸시 후 확인 실패 "
          f"(읽은 내용: {verify.stdout.strip()[:200]})", file=sys.stderr)
    return False


# 연결된 모든 기기에 deviceId를 start_id부터 순서대로 배정해서 한 번에 push한다.
# 시리얼을 정렬해서 매번 같은 순서가 나오게 한다 (재현 가능성) - 그래도 "어느 시리얼이
# 어느 물리적 폰인지"는 사람이 알 수 없으므로, 실행 전 매핑을 보여주고 확인을 받는다.
def push_sequential(start_id, configs_dir, skip_confirm):
    serials = sorted(connected_serials())
    if not serials:
        print("[!] 연결된 adb 기기가 없습니다.", file=sys.stderr)
        sys.exit(1)

    mapping = [(serial, start_id + i) for i, serial in enumerate(serials)]

    print(f"[i] 연결된 기기 {len(serials)}대 - deviceId {start_id}부터 순서대로 배정 예정:",
          file=sys.stderr)
    missing = []
    for serial, device_id in mapping:
        config_path = os.path.join(configs_dir, f"{device_id}.json")
        if os.path.isfile(config_path):
            print(f"  {serial} -> deviceId={device_id}", file=sys.stderr)
        else:
            print(f"  {serial} -> deviceId={device_id}  [!] config 파일 없음", file=sys.stderr)
            missing.append(device_id)

    if missing:
        print(f"[!] configs/*.json 없는 deviceId가 있습니다: {missing} - "
              "gen_configs.py 결과나 --start-id를 확인하세요.", file=sys.stderr)
        sys.exit(1)

    if not skip_confirm:
        answer = input("이대로 진행할까요? [y/N] ").strip().lower()
        if answer != "y":
            print("[i] 취소했습니다.", file=sys.stderr)
            return

    results = [push_one(serial, device_id, configs_dir) for serial, device_id in mapping]
    ok = sum(results)
    print(f"[{'OK' if ok == len(mapping) else '!'}] {ok}/{len(mapping)}대 완료", file=sys.stderr)
    if ok != len(mapping):
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="MediaSphere config.json adb 푸시 (최초 부트스트랩 전용)")
    ap.add_argument("device_id", type=int, nargs="?", help="밀어넣을 폰의 deviceId (단일 기기 모드)")
    ap.add_argument("--serial", help="adb 기기 시리얼 (여러 대 연결 시 필수, 'adb devices'로 확인)")
    ap.add_argument("--configs-dir", default=DEFAULT_CONFIGS_DIR,
                     help="gen_configs.py 결과 폴더 (기본: server/distribute/configs)")
    ap.add_argument("--list", action="store_true", help="연결된 adb 기기 목록만 보고 종료")
    ap.add_argument("--sequential", action="store_true",
                     help="연결된 모든 기기에 --start-id부터 순서대로 배정해서 한 번에 push")
    ap.add_argument("--start-id", type=int, help="--sequential 사용 시 첫 기기에 배정할 deviceId")
    ap.add_argument("-y", "--yes", action="store_true",
                     help="--sequential 실행 전 확인 프롬프트 생략")
    a = ap.parse_args()

    if a.list:
        list_devices()
        return

    if a.sequential:
        if a.device_id is not None or a.serial:
            ap.error("--sequential은 deviceId/--serial과 함께 쓸 수 없습니다.")
        if a.start_id is None:
            ap.error("--sequential에는 --start-id가 필요합니다.")
        push_sequential(a.start_id, a.configs_dir, a.yes)
        return

    if a.device_id is None:
        ap.error("deviceId를 지정하세요 (또는 --sequential / --list)")

    serial = resolve_serial(a.serial)
    if not push_one(serial, a.device_id, a.configs_dir):
        sys.exit(1)


if __name__ == "__main__":
    main()
