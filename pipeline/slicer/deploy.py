#!/usr/bin/env python3
"""
MediaSphere - 배포 파이프라인 원클릭 실행기

slice_video.py -> gen_manifest.py -> gen_configs.py 세 단계를 순서대로 실행해서
server/distribute/ 를 한 번에 채운다. 한 단계라도 실패(0이 아닌 exit code)하면
즉시 멈춘다 - 예전에 slice_video.py만 돌리고 gen_manifest.py를 빼먹어서
서버가 manifest.json을 못 찾은 사고가 있었는데, 이 스크립트를 쓰면 그럴 수 없다.

사용 예:
  python3 deploy.py -i master.mp4 -t tiles/tiles_flat100_pitch4k.json \
      --ap-count 15 --base-config base-config.example.json \
      -o ../../server/distribute --encoder hevc_nvenc

--dry-run을 주면 slice_video.py만 --dry-run으로 돌려 ffmpeg 명령을 확인하고
(실제 영상 파일이 없으므로) gen_manifest.py/gen_configs.py는 건너뛴다.

--skip-slice를 주면 slice_video.py(가장 오래 걸리는 GPU 인코딩 단계)를 건너뛰고
이미 만들어둔 {outdir}/videos/slice_manifest.json으로 gen_manifest.py부터 이어서
실행한다 - AP 대수나 base-config만 바뀌어서 영상은 그대로 재사용할 때 쓴다.
이때는 -i/-t가 필요 없다.
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def run(cmd):
    print(f"[deploy] $ {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f"[deploy] 중단 - 실패(exit={result.returncode}): {' '.join(cmd)}", file=sys.stderr)
        sys.exit(result.returncode)


def main():
    ap = argparse.ArgumentParser(description="MediaSphere 배포 파이프라인 원클릭 실행기")
    ap.add_argument("-i", "--input", help="원본 영상 (master.mp4). --skip-slice면 불필요")
    ap.add_argument("-t", "--tiles", help="tiles.json (gen_tiles.py 결과). --skip-slice면 불필요")
    ap.add_argument("--ap-count", type=int, required=True, help="현장 AP(SSID) 대수")
    ap.add_argument("--base-config", required=True,
                     help="전 폰 공통 config 값 (base-config.example.json 참고)")
    ap.add_argument("-o", "--outdir", default=os.path.join(HERE, "..", "..", "server", "distribute"),
                     help="기본값: server/distribute/")
    ap.add_argument("--encoder", default="libx264", help="slice_video.py로 그대로 전달")
    ap.add_argument("--quality", type=int, default=20, help="slice_video.py로 그대로 전달")
    ap.add_argument("-j", "--jobs", type=int, default=4, help="slice_video.py로 그대로 전달")
    ap.add_argument("--dry-run", action="store_true",
                     help="slice_video.py만 --dry-run으로 실행하고 이후 단계는 생략")
    ap.add_argument("--skip-slice", action="store_true",
                     help="이미 잘라둔 영상을 재사용 - slice_video.py를 건너뛰고 "
                          "{outdir}/videos/slice_manifest.json부터 이어서 실행")
    a = ap.parse_args()

    if a.skip_slice and a.dry_run:
        ap.error("--skip-slice와 --dry-run은 같이 쓸 수 없습니다.")
    if not a.skip_slice and (not a.input or not a.tiles):
        ap.error("-i/--input과 -t/--tiles는 --skip-slice가 아니면 필수입니다.")

    python = sys.executable
    videos_dir = os.path.join(a.outdir, "videos")
    slice_manifest = os.path.join(videos_dir, "slice_manifest.json")

    if a.skip_slice:
        if not os.path.isfile(slice_manifest):
            print(f"[deploy] 중단 - --skip-slice인데 {slice_manifest}가 없습니다. "
                  f"먼저 slice_video.py(또는 --skip-slice 없이 deploy.py)를 실행하세요.", file=sys.stderr)
            sys.exit(1)
        print(f"[deploy] --skip-slice - {slice_manifest} 재사용", file=sys.stderr)
    else:
        slice_cmd = [
            python, os.path.join(HERE, "slice_video.py"),
            "-i", a.input, "-t", a.tiles, "-o", videos_dir,
            "--encoder", a.encoder, "--quality", str(a.quality), "-j", str(a.jobs),
        ]
        if a.dry_run:
            slice_cmd.append("--dry-run")
        run(slice_cmd)

        if a.dry_run:
            print("[deploy] --dry-run - gen_manifest.py/gen_configs.py는 생략", file=sys.stderr)
            return

    final_manifest = os.path.join(a.outdir, "manifest.json")
    run([
        python, os.path.join(HERE, "gen_manifest.py"),
        "-i", slice_manifest, "--ap-count", str(a.ap_count), "-o", final_manifest,
    ])

    configs_dir = os.path.join(a.outdir, "configs")
    run([
        python, os.path.join(HERE, "gen_configs.py"),
        "-i", final_manifest, "--base-config", a.base_config, "-o", configs_dir,
    ])

    print(f"[OK] 배포 준비 완료 - {a.outdir}", file=sys.stderr)
    print("[i] 서버에서 POST /api/distribute/publish 호출해서 폰에 발행하세요", file=sys.stderr)


if __name__ == "__main__":
    main()
