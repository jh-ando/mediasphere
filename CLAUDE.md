# MediaSphere — CLAUDE.md

## 프로젝트 정의
500대 Galaxy A15를 지름 2m 구체에 배치하고
마스터 서버(Node.js)가 UDP 멀티캐스트로 타임코드를
브로드캐스트하여 360도 영상을 정밀 동기화 재생하는
미디어 설치 시스템.

## 현재 개발 단계
Phase 1: 서버 기본 구조 + 폰 1대 동기화 테스트

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
└── docs/          ← 문서

## MQTT 토픽 구조
- wall/control     : 서버 → 전체 (PLAY/STOP/LOAD/CHECK_UPDATE)
- wall/device/{id} : 서버 → 개별
- wall/status/{id} : 폰 → 서버 (heartbeat)
- wall/ready/{id}  : 폰 → 서버 (다운로드 완료)
- wall/error/{id}  : 폰 → 서버 (오류)

## config.json 위치 (폰 내부)
/sdcard/mediasphere/config.json

## 코드 컨벤션
- Node.js: CommonJS (require), async/await
- Kotlin: Coroutine 기반 비동기
- 주석: 한국어
- 로그 태그: [UDP] [MQTT] [HTTP] [Player]

## 개발 단계
- [x] Phase 0: 테스트 앱 성능 검증
        480p, CPU 40%, 온도 33도, 2시간 안정
- [x] Phase 1: 서버 기본 구조 + 폰 1대 동기화
- [ ] Phase 2: MQTT 제어 + 16대 확장
- [ ] Phase 3: FFmpeg 파이프라인 + 역변환 보정
- [ ] Phase 4: 모니터링 대시보드 + 500대

## 주의사항
- WifiManager.MulticastLock 없으면 UDP 수신 안 됨
- ExoPlayer seekTo()는 메인 스레드에서만 호출
- MQTT 콜백에서 UI 수정 시 runOnUiThread 필수
- 폰 1대/16대/500대 모두 같은 APK, config.json만 다름

## Git 규칙
각 기능 완성 후 내가 "커밋해줘"라고 하면
적절한 메시지로 git commit 실행.
자동 커밋은 하지 말 것.

## 임시 구현 사항 (추후 변경 예정)
- PLAY/STOP 제어: MQTT 대신 UDP 타임코드에
  isPlaying 필드 임시 포함
  → Phase 2에서 MQTT로 교체 예정