# MediaSphere — CLAUDE.md

## 프로젝트 정의
439대 Galaxy A15를 지름 1.8m 구체에 배치하고
마스터 서버(Node.js)가 UDP 멀티캐스트로 타임코드를
브로드캐스트하여 360도 영상을 정밀 동기화 재생하는
미디어 설치 시스템.

## 현재 개발 단계
Phase 3 진행 중:
- 15대 분할 재생 + 키오스크 연동 클라이언트 시연 완료
- 다음: 100대 확장 + 텍스트 스크롤 + 텍스트 패턴 구현

## 아키텍처
- 타임코드: UDP 멀티캐스트 239.0.0.1:5000 (30fps)
- 제어 명령: MQTT (Mosquitto) localhost:1883
- 파일 배포: HTTP :3000/clips/
- 대시보드: WebSocket :3000

## 동기화 목표
- 재생 시작 오차: < 16ms
- 드리프트 허용: < 50ms
- 보정: 속도 ±2% / 200ms 초과 시 seek

## 기술 스택
- 서버: Node.js 20 LTS, Ubuntu 24.04
- Android: Kotlin, ExoPlayer Media3, Paho MQTT
- 파이프라인: Python 3.11, FFmpeg
- 브로커: Mosquitto

## 폰 배치 (확정)
- 총 439대, 전부 포트레이트
- 위도는 폰 중심 기준
- 위도 간격: 90/7 ≈ 12.857°
- 0° → 50대
- ±12.86° → 각 50대 (100대)
- ±25.71° → 각 50대 (100대)
- ±38.57° → 각 40대 (80대)
- ±51.43° → 각 30대 (60대)
- ±64.29° → 각 20대 (40대)
- −77.14° → 9대 (+77.14°는 배치 없음)
- gen_tiles.py SPHERE_ROWS 업데이트 필요 (100대 테스트 때)

## 폰 스펙 (검증 완료)
- 기종: Galaxy A15
- 재생 해상도: 480×854 (480p)
- CPU 사용률: ~60% (1시간 연속, 33도 유지)
- 영상 코덱: H.264 하드웨어 디코딩
- Wi-Fi: 5GHz 전용 폐쇄망

## 폴더 구조
MediaSphere/
├── CLAUDE.md
├── server/        ← Node.js 마스터 서버
│   ├── src/
│   └── public/    ← 대시보드 UI, kiosk-test.html
├── android/       ← Android 앱 (Kotlin)
├── pipeline/      ← Python 영상 처리
│   └── slicer/    ← 원본 영상 → 폰별 타일 분할 (gen_tiles.py + slice_video.py)
│                     오프라인 도구, 서버 런타임과 별도 실행. 외부 패키지 없음
│                     (단, preview_rig.py만 Pillow 필요)
└── docs/          ← 문서

## 영상 분할 표준 워크플로우
매번 원본 영상이 바뀔 때마다 반복하는 순서. tiles.json은
"이 해상도의 원본"을 전제로 좌표가 박제되므로, 원본 해상도가
바뀌면 반드시 다시 생성해야 함 (재사용 금지).

1. 원본 해상도 확인
   ffprobe -v error -select_streams v:0 \
     -show_entries stream=width,height master.mp4

2. 그 해상도에 맞춰 tiles.json 생성
   - 배치(cols/rows)와 리그 피치(--pitch, 현재 110x200mm)는 고정
   - --downscale 값만 원본 해상도에 맞게 역산 (요구 원본 크기 / 실제 원본 크기)
   예)
   python3 gen_tiles.py flat --cols 20 --rows 5 --pitch 110x200 \
     --downscale 8.94 -o tiles/tiles_flat100.json

3. 자르기
   python3 slice_video.py -i master.mp4 -t tiles/tiles_flat100.json \
     -o out/ --encoder hevc_nvenc -j 6

주의: tiles.json의 source.width/height와 실제 master.mp4 해상도가
일치해야 crop 좌표가 정확함. 확대율(report에 출력됨)이 크면
화질 저하 신호 — 15대 테스트 시 확대율 ~8배가 실사용 기준으로 확인됨.

향후: 위 3단계를 해상도 자동 감지 + downscale 자동 계산까지
묶어 원클릭 스크립트로 만드는 것 검토 (미구현)

## 앱 동작 모드
세 가지 모드. 모드 전환 시 이전 모드는 완전히 비활성화.

### 영상 모드 (기본)
- ExoPlayer로 영상 재생
- UDP 타임코드로 드리프트 보정
- PatternView 숨김

### 패턴 모드
- ExoPlayer 정지 및 숨김
- PatternView (전체화면 단색 View) 표시
- ValueAnimator로 점멸 / 컬러 변화 제어
- UDP 타임코드 수신 중단
- 텍스트 패턴 포함 (아래 참조)

### 컬러 오버레이 모드 (영상 모드 위에 레이어)
- 영상 재생 유지
- colorOverlayView를 영상 위에 반투명 표시
- ValueAnimator로 1초 주기 10회 페이드 인/아웃 후 자동 소멸
- colorOverlayAlpha: config.json 설정 (기본 0.35)
- PATTERN_START 진입, STOP, onDestroy 시 자동 해제

## MQTT 토픽 구조
- wall/control     : 서버 → 전체
- wall/device/{id} : 서버 → 개별
- wall/status/{id} : 폰 → 서버 (heartbeat, 5초마다)
- wall/ready/{id}  : 폰 → 서버 (다운로드 완료)
- wall/error/{id}  : 폰 → 서버 (오류)
- wall/state/color : 서버 → 전체 (retain, 현재 컬러 상태)

## MQTT 명령 타입 (wall/control)

### 영상 모드
- PLAY        : {"type":"PLAY","startAt":밀리초}
- STOP        : {"type":"STOP","elapsedMs":밀리초}
- LOAD        : {"type":"LOAD","filename":"xxx.mp4"}
- CHECK_UPDATE: {"type":"CHECK_UPDATE"}

### 모드 전환
- MODE_VIDEO  : {"type":"MODE_VIDEO"}
                영상 모드로 전환, 패턴 모드 비활성화
- MODE_PATTERN: {"type":"MODE_PATTERN"}
                패턴 모드로 전환, 영상 모드 비활성화

### 패턴 모드
- PATTERN_START: {"type":"PATTERN_START","color":"#FFFFFF",
                  "interval":500,"duration":3000,
                  "startAt":밀리초}
                 duration=0이면 무한 반복
- PATTERN_STOP : {"type":"PATTERN_STOP"}
                 점멸 정지, 마지막 색상 유지
- COLOR_CHANGE : {"type":"COLOR_CHANGE","color":"#RRGGBB",
                  "startAt":밀리초,"duration":밀리초,
                  "stress":0.0~1.0,"source":"kiosk"}
                 1초 주기 10회 점멸 후 자동 소멸
- COLOR_CLEAR  : {"type":"COLOR_CLEAR","startAt":밀리초}
                 컬러 오버레이 즉시 제거

### 텍스트 스크롤 (신규 - 미구현)
- TEXT_SCROLL  : {"type":"TEXT_SCROLL","text":"Hello",
                  "color":"#FFFFFF","bgColor":"#000000",
                  "speed":1.0,"direction":"horizontal",
                  "startAt":밀리초}
                 서버가 각 폰의 구체 위치(위도/경도)를 기반으로
                 폰별로 다른 startDelay를 계산해 개별 발행.
                 텍스트가 구체 표면을 따라 흐르는 효과.
- TEXT_STOP    : {"type":"TEXT_STOP"}

### 텍스트 패턴 (신규 - 미구현)
- TEXT_PATTERN : {"type":"TEXT_PATTERN","text":"Hi",
                  "color":"#FFFFFF","bgColor":"#000000",
                  "startAt":밀리초}
                 폰들을 픽셀 삼아 텍스트를 구체 표면에 표시.
                 서버가 각 폰이 텍스트의 어느 픽셀에 해당하는지
                 계산하여 색(전경/배경)을 개별 발행.

## HTTP API 엔드포인트
- POST /api/play
- POST /api/stop
- POST /api/mode           {"mode":"video"|"pattern"}
- POST /api/pattern/config {"color":"#FFFFFF","interval":500,"duration":3000}
- POST /api/pattern/start
- POST /api/pattern/stop
- POST /api/color-change   {"stress":0.0~1.0,"color":"#RRGGBB","leadTime":2000}
- POST /api/color-clear
- POST /api/text-scroll    {"text":"Hello","color":"#FFFFFF","speed":1.0} (미구현)
- POST /api/text-pattern   {"text":"Hi","color":"#FFFFFF"} (미구현)

## config.json 위치 (폰 내부)
/sdcard/mediasphere/config.json

## 코드 컨벤션
- Node.js: CommonJS (require), async/await
- Kotlin: Coroutine 기반 비동기
- 주석: 한국어
- 로그 태그: [UDP] [MQTT] [HTTP] [Player] [Pattern]

## 개발 단계
- [x] Phase 0: 테스트 앱 성능 검증
        480p, CPU 40%, 온도 33도, 2시간 안정
- [x] Phase 1: 서버 기본 구조 + 폰 1대 동기화
- [x] Phase 2: MQTT 제어 + 16대 확장
        [x] MQTT 정식 구현 (PLAY/STOP retain)
        [x] 대시보드 기본 UI + 기기 그리드
        [x] Android heartbeat 발행
        [x] 패턴 모드 (점멸)
        [x] 16대 스케일업 테스트
- [ ] Phase 3: FFmpeg 파이프라인 + 신규 기능
        [x] 15대 분할 재생 테스트 (클라이언트 시연 완료)
        [x] 키오스크 연동 테스트
              kiosk-test.html, color picker → /api/color-change
              → MQTT COLOR_CHANGE → 폰 컬러 오버레이 확인
              ※ 키오스크 인터랙션 방식 미확정 — 확정 후 교체 예정
        [x] COLOR_CHANGE Android 구현
              1초 주기 10회 점멸 후 자동 소멸
              wall/state/color retain으로 재부팅 폰 상태 복구
        [x] FFmpeg 파이프라인 구축 (pipeline/slicer/)
              평면 15분할 + 구체 439분할 동일 tiles.json 스키마
              [ ] manifest.json → 폰별 config.json 자동 생성/배포 (미구현)
              [ ] 폰 파일 수신 검증 (체크섬/heartbeat) (미구현)
              [ ] 대시보드 연동 (업로드 → 분할 → 진행률) (미구현)
        [ ] 100대 확장 테스트 (진행 중)
              15대 → 100대 스케일업 (20열 x 5행 배치)
              [x] tiles.json 생성 (4K 원본 기준, 확대율 9.0배로 15대와 유사)
              [ ] 4K 원본 영상으로 실제 slice_video.py 실행
             네트워크/동기화 안정성 재검증
        [ ] 텍스트 스크롤 (신규)
              서버 대시보드에서 텍스트 입력 → 구체 표면을 텍스트가 흐름
              각 폰의 위도/경도 기반으로 서버가 startDelay 계산
              wall/device/{id}로 개별 발행
        [ ] 텍스트 패턴 (신규)
              "Hi" 같은 짧은 텍스트를 폰 전체를 픽셀로 사용해 표시
              패턴 모드 내 기능으로 구현
        [ ] 역변환 보정 (우선순위 낮음 - 육안 차이 확인 후 판단)
- [ ] Phase 4: 모니터링 대시보드 + 439대

## 클라이언트 요구사항
- 점멸 패턴: 패턴 모드에서 화면 점멸 ✅
- 스트레스 컬러 오버레이: ✅ (키오스크 모킹으로 검증 완료)
    → 실제 인터랙션 방식 미확정 (키오스크 외 다른 방식 검토 중)
- 텍스트 스크롤: 구체 표면을 따라 텍스트가 흐르는 애니메이션
- 텍스트 패턴: 폰들을 픽셀 삼아 "Hi" 등 간단한 텍스트 표시
- 100대 규모 시연

## 신규 기능 설계 노트

### 텍스트 스크롤 구현 방향
- 서버가 각 폰의 구체 위 위치(위도/경도)를 알고 있음
- 텍스트가 경도 방향으로 흐를 경우:
  서버가 경도 순서로 각 폰에 delay를 계산해 개별 MQTT 발행
- Android: 지정된 startAt에 텍스트 오버레이 표시 후 슬라이드 아웃

### 텍스트 패턴 구현 방향
- 구체 표면의 폰 배치를 픽셀 그리드로 취급
- 서버가 텍스트 비트맵을 렌더링하고 각 폰 위치와 매핑
- 전경색 폰 → COLOR_CHANGE, 배경색 폰 → 다른 COLOR_CHANGE 개별 발행
- 폰 해상도(1대)가 아닌 폰 배치 자체를 픽셀로 사용

## 주의사항
- WifiManager.MulticastLock 없으면 UDP 수신 안 됨
- ExoPlayer seekTo()는 메인 스레드에서만 호출
- MQTT 콜백에서 UI 수정 시 runOnUiThread 필수
- 폰 1대/16대/439대 모두 같은 APK, config.json만 다름
- 모드 전환 시 이전 모드 리소스 반드시 정리
  (ExoPlayer pause + PatternView ValueAnimator cancel)
- 일부 Android 14 기기(3버튼 내비게이션)에서
  전체화면 적용 시 systemUiVisibility 레거시 플래그 병행 적용 필요
- 서버 파워모드는 퍼포먼스 모드 고정 필요
  (밸런스 모드 전환 시 타임코드 지연 → 동기화 이탈 발생 확인됨)
- 화면 잠금/절전 비활성화 필수
  (잠금화면 전환 시 일부 폰 동기화 이탈 가능성 있음)

## Git 규칙
각 기능 완성 후 내가 "커밋해줘"라고 하면
적절한 메시지로 git commit 실행.
자동 커밋은 하지 말 것.

