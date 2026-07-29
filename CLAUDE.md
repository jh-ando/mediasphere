# MediaSphere — CLAUDE.md

## 프로젝트 정의
499대 Galaxy A15를 지름 2m 구체에 배치하고
마스터 서버(Node.js)가 UDP 멀티캐스트로 타임코드를
브로드캐스트하여 360도 영상을 정밀 동기화 재생하는
미디어 설치 시스템.

## 현재 개발 단계
Phase 3: FFmpeg 파이프라인 + 역변환 보정

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
│   └── public/    ← 대시보드 UI
├── android/       ← Android 앱 (Kotlin)
├── pipeline/      ← Python 영상 처리
│   └── slicer/    ← 원본 영상 → 폰별 타일 분할 (gen_tiles.py + slice_video.py)
│                     오프라인 도구, 서버 런타임과 별도 실행. 외부 패키지 없음
│                     (단, preview_rig.py만 Pillow 필요)
└── docs/          ← 문서

## 앱 동작 모드
두 가지 모드가 상호 배타적으로 동작.
모드 전환 시 이전 모드는 완전히 비활성화.

### 영상 모드 (기본)
- ExoPlayer로 영상 재생
- UDP 타임코드로 드리프트 보정
- PatternView 숨김

### 패턴 모드
- ExoPlayer 정지 및 숨김
- PatternView (전체화면 단색 View) 표시
- ValueAnimator로 점멸 / 컬러 변화 제어
- UDP 타임코드 수신 중단

## MQTT 토픽 구조
- wall/control     : 서버 → 전체
- wall/device/{id} : 서버 → 개별
- wall/status/{id} : 폰 → 서버 (heartbeat, 5초마다)
- wall/ready/{id}  : 폰 → 서버 (다운로드 완료)
- wall/error/{id}  : 폰 → 서버 (오류)

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
                  "startAt":밀리초}
                 (미구현 - baikal.ai 스펙 확정 후 진행)

## HTTP API 엔드포인트
- POST /api/play
- POST /api/stop
- POST /api/mode           {"mode":"video"|"pattern"}
- POST /api/pattern/config {"color":"#FFFFFF","interval":500,"duration":3000}
                            (발행 없이 서버에 설정만 저장)
- POST /api/pattern/start  (저장된 patternConfig로 PATTERN_START 발행)
- POST /api/pattern/stop
- POST /api/color-change   {"color":"#RRGGBB"} (미구현)

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
- [ ] Phase 3: FFmpeg 파이프라인 + 역변환 보정
        [x] 15대 분할 재생 테스트
              3행 5열 평면 배치 (일정 간격)
              원본 영상을 FFmpeg로 15개 영역으로 crop
              각 폰이 자기 영역 영상만 재생
              전체가 하나의 큰 화면처럼 보이는 것 확인
              기존 UDP 타임코드 동기화 그대로 사용
        [x] 키오스크 연동 테스트
              server/public/kiosk-test.html 제작
              color picker로 HTTP POST /api/color-change 전송
              → 서버 → MQTT COLOR_CHANGE → 폰 컬러 오버레이 확인
              baikal.ai API 스펙 확정 전 모킹으로 진행
        [x] COLOR_CHANGE Android 구현 (baikal.ai 스펙 확정 후)
        [x] FFmpeg 파이프라인 구축 (pipeline/slicer/ - gen_tiles.py/slice_video.py)
              평면 15분할 + 구체 499분할 동일 tiles.json 스키마로 처리
              [ ] manifest.json → 폰별 config.json 자동 생성/배포 (미구현)
              [ ] 폰 파일 수신 검증 (체크섬/heartbeat) (미구현)
              [ ] 대시보드 연동 (업로드 → 분할 실행 → 진행률) (미구현)
        [ ] 역변환 보정 (rectilinear, 우선순위 낮음 - 육안 차이 확인 후 판단)
        [ ] 아틀라스 팩킹 (우선순위 낮음 - 8K로 화질 부족 판단 시 검토)
- [ ] Phase 4: 모니터링 대시보드 + 500대

## 클라이언트 요구사항
- 점멸 패턴: 패턴 모드에서 화면 점멸 ✅
- 스트레스 컬러 오버레이:
    마이크 → baikal.ai API → 스트레스 지수 0.0~1.0
    → COLOR_CHANGE 명령 → ValueAnimator 색상 변화
    → startAt 절대시각으로 500대 동시 전환
    키오스크 → HTTP POST /api/color-change 방식 확정

## 주의사항
- WifiManager.MulticastLock 없으면 UDP 수신 안 됨
- ExoPlayer seekTo()는 메인 스레드에서만 호출
- MQTT 콜백에서 UI 수정 시 runOnUiThread 필수
- 폰 1대/16대/500대 모두 같은 APK, config.json만 다름
- 모드 전환 시 이전 모드 리소스 반드시 정리
  (ExoPlayer pause + PatternView ValueAnimator cancel)
- 일부 Android 14 기기(3버튼 내비게이션)에서
  전체화면 적용 시 systemUiVisibility 레거시 플래그
  병행 적용 필요

## Git 규칙
각 기능 완성 후 내가 "커밋해줘"라고 하면
적절한 메시지로 git commit 실행.
자동 커밋은 하지 말 것.