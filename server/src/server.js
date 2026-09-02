// MediaSphere 마스터 서버
// Phase 1: UDP 멀티캐스트 타임코드 브로드캐스트 + REST 제어 API
// Phase 2: MQTT(wall/control)로 PLAY/STOP/LOAD/CHECK_UPDATE 제어 명령 발행
//          + WebSocket 대시보드 (기기 온라인 현황/재생 상태 브로드캐스트)

const path = require('path');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const mqtt = require('mqtt');
const { WebSocketServer, WebSocket } = require('ws');
const { stressToColor } = require('../lib/stressColor');
const { computeTextPatternGrid } = require('../lib/textPatternGrid');

// ── 설정값 ──────────────────────────────────────────
const MULTICAST_ADDR = '239.0.0.1';
const MULTICAST_PORT = 5000;
const FPS = 30;
const TICK_MS = 1000 / FPS;
const HTTP_PORT = 3000;
const MQTT_BROKER_URL = 'mqtt://localhost:1883';
const MQTT_CONTROL_TOPIC = 'wall/control';
const MQTT_COLOR_STATE_TOPIC = 'wall/state/color';
const MQTT_STATUS_TOPIC_FILTER = 'wall/status/+';
const MQTT_READY_TOPIC_FILTER = 'wall/ready/+';
const MQTT_ERROR_TOPIC_FILTER = 'wall/error/+';
const MQTT_DEVICE_TOPIC_PREFIX = 'wall/device/';
const MQTT_PATTERN_CELL_TOPIC_PREFIX = 'wall/pattern/';
const MQTT_OTA_TOPIC = 'wall/ota';
const MQTT_OTA_STATUS_TOPIC_FILTER = 'wall/ota/status/+';
const DEFAULT_OTA_STEP_DELAY_MS = 200; // 롤링 배포 - 폰마다 (deviceId-1)*stepDelayMs 만큼 시차를 둔다
const TOTAL_DEVICES = 439; // 구체 배치 위도별 합산 기준 (CLAUDE.md "폰 배치 (확정)" 참고) - 499는 확정 전 배치안
const OFFLINE_TIMEOUT_MS = 10000; // 10초 이상 heartbeat 없으면 offline 처리
const STATUS_BROADCAST_MS = 1000;
const PATTERN_CONFIG_PATH = path.join(__dirname, '..', 'data', 'pattern-config.json');
const TEXT_SCROLL_CONFIG_PATH = path.join(__dirname, '..', 'data', 'text-scroll-config.json');
const TEXT_PATTERN_CONFIG_PATH = path.join(__dirname, '..', 'data', 'text-pattern-config.json');
const DEPLOY_CONFIG_PATH = path.join(__dirname, '..', 'data', 'deploy-config.json');
// 폐쇄망 로컬 MQTT라 개별 발행(최대 439건)도 통상 수십~수백ms 안에 전달된다 - 1초면
// 여유 있음. 혹시 이 시각을 놓친 폰이 있어도 TextPatternAnimator가 즉시(지연 0으로)
// 페이드인을 시작할 뿐 에러 없이 우아하게 처리된다(그 폰만 살짝 늦게 보일 뿐).
const DEFAULT_TEXT_PATTERN_LEAD_TIME_MS = 1000;
// "video"/"pattern"만 받던 /api/mode를 "text"까지 세 값으로 확장하면서, 매핑을 한 곳에 모아둔다.
const MODE_MQTT_TYPES = { video: 'MODE_VIDEO', pattern: 'MODE_PATTERN', text: 'MODE_TEXT' };
const DEFAULT_TEXT_LEAD_TIME_MS = 3000; // 439대가 명령을 다 받을 시간 여유 - OTA와 비슷한 이유로 컬러보다 넉넉히
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_COLOR_DURATION_MS = 3000;
const DEFAULT_COLOR_LEAD_TIME_MS = 2000;
const DEFAULT_OTA_LEAD_TIME_MS = 3000; // 다운로드+설치 파이프라인 전체를 트리거하므로 컬러 전환보다 여유를 더 둠
const DEFAULT_SHOW_ID_DURATION_MS = 5000; // Android MqttManager의 기본값과 맞춤

// ── 파일 배포(manifest/config/영상) 경로 ──────────────────
// pipeline/slicer의 gen_manifest.py, gen_configs.py가 이 구조로 결과물을 채워 넣는 것을 전제로 한다:
//   server/distribute/videos/*.mp4   (slice_video.py -o를 여기로 지정)
//   server/distribute/manifest.json  (gen_manifest.py -o)
//   server/distribute/configs/*.json (gen_configs.py -o)
const DISTRIBUTE_DIR = path.join(__dirname, '..', 'distribute');
const MANIFEST_PATH = path.join(DISTRIBUTE_DIR, 'manifest.json');
const CONFIGS_DIR = path.join(DISTRIBUTE_DIR, 'configs');
const VIDEOS_DIR = path.join(DISTRIBUTE_DIR, 'videos');

// ── 대시보드 영상 교체 (업로드 → 분할 → 배포 원클릭) ─────────
// pipeline/slicer의 gen_tiles.py/deploy.py를 자식 프로세스로 그대로 호출한다 - 별도
// 파이프라인을 새로 만들지 않고 이미 검증된 CLI 스크립트를 그대로 재사용.
const SLICER_DIR = path.join(__dirname, '..', '..', 'pipeline', 'slicer');
const BASE_CONFIG_PATH = path.join(SLICER_DIR, 'base-config.example.json');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
// gen_tiles.py --source 목표 해상도 - 등장방형은 2:1 관례값(4096x2048), 전/후면 미러는
// 1:1 정사각(2160x2160). 실제 업로드 파일 해상도가 다르면 slice_video.py가 이미
// 자동으로 중앙 크롭+스케일 처리하므로(--fit crop 기본값) 여기서 별도 리사이즈는 안 한다.
const VIDEO_REPLACE_TARGET_SIZE = { equirect: '4096x2048', frontback: '2160x2160' };

// ── APK 배포(OTA) 경로 ────────────────────────────────
// scripts/publish-apk.js가 APK를 넣고 이 파일을 갱신하는 것을 전제로 한다.
// 서버 프로세스는 이 값을 캐시하지 않고 매 요청마다 새로 읽는다 - publish-apk.js가
// 별도 프로세스로 실행되므로, 서버가 시작 시점 값을 들고 있으면 갱신을 못 본다.
const APK_DIR = path.join(__dirname, '..', 'apk');
const APK_VERSION_PATH = path.join(__dirname, '..', 'data', 'app-version.json');

// ── 재생 상태 ────────────────────────────────────────
// isPlaying: 재생 중 여부
// startAt: 재생이 시작된 기준 시각 (epoch ms). 폰은 이 값과 자신의 로컬 시각을
//          비교해 재생 위치를 계산한다.
// stoppedElapsedMs: 정지 시점의 elapsedMs. 정지 중에는 이 값을 그대로 내려보내
//                   폰이 정지된 위치를 알 수 있게 한다.
const state = {
  isPlaying: false,
  startAt: Date.now(),
  stoppedElapsedMs: 0,
  // currentMode: "video" | "pattern" | "text" - 세 모드는 상호 배타적이다.
  currentMode: 'video',
  patternConfig: {
    color: '#FFFFFF',
    interval: 500,
    duration: 3000,
    stepDelay: 200,
  },
  textScrollConfig: {
    text: 'MediaSphere',
    font: 'sans-serif',
    fontSize: 120,
    color: '#FFFFFF',
    bgColor: '#000000',
    align: 'center', // left | center | right
    direction: 'left', // left | right | up | down
    speed: 200, // px/sec
  },
  textPatternConfig: {
    text: 'Hi',
    fgColor: '#FFFFFF',
    bgColor: '#000000',
    charStaggerMs: 400, // 글자 하나가 페이드인을 시작하고 다음 글자가 시작하기까지의 간격
    fadeInMs: 400,
    holdMs: 3000, // 모든 글자가 다 켜진 뒤 유지하는 시간
    fadeOutMs: 400,
  },
  // 키오스크 스트레스 컬러 오버레이의 현재 상태. null이면 오버레이 없음(초기화된 상태).
  currentColor: {
    color: null,
    stress: null,
  },
  // 대시보드 영상 교체가 쓰는 AP(SSID) 대수 - 현장 배치 후 거의 안 바뀌므로 매번 입력받지
  // 않고 저장해뒀다가 재사용한다.
  deployConfig: {
    apCount: 10,
  },
};

// patternConfig를 pattern-config.json에 저장한다 (POST /api/pattern/config 호출 시마다).
function savePatternConfig() {
  try {
    fs.mkdirSync(path.dirname(PATTERN_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(PATTERN_CONFIG_PATH, JSON.stringify(state.patternConfig, null, 2));
  } catch (err) {
    console.error('[HTTP] pattern-config.json 저장 실패:', err.message);
  }
}

// 서버 시작 시 저장된 patternConfig가 있으면 불러온다. 없거나 파싱에 실패하면 기본값을 유지한다.
function loadPatternConfig() {
  if (!fs.existsSync(PATTERN_CONFIG_PATH)) return;

  try {
    // 기본값 위에 덮어써서 병합한다 - 예전 파일에 없는 새 필드(stepDelay 등)는 기본값을 유지한다.
    const loaded = JSON.parse(fs.readFileSync(PATTERN_CONFIG_PATH));
    state.patternConfig = { ...state.patternConfig, ...loaded };
    console.log(`[HTTP] pattern-config.json 로드 완료 - ${JSON.stringify(state.patternConfig)}`);
  } catch (err) {
    console.error('[HTTP] pattern-config.json 파싱 실패 - 기본값 유지:', err.message);
  }
}

loadPatternConfig();

// textScrollConfig를 text-scroll-config.json에 저장한다 (POST /api/text/config 호출 시마다).
function saveTextScrollConfig() {
  try {
    fs.mkdirSync(path.dirname(TEXT_SCROLL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEXT_SCROLL_CONFIG_PATH, JSON.stringify(state.textScrollConfig, null, 2));
  } catch (err) {
    console.error('[HTTP] text-scroll-config.json 저장 실패:', err.message);
  }
}

// 서버 시작 시 저장된 textScrollConfig가 있으면 불러온다 (loadPatternConfig와 동일 패턴).
function loadTextScrollConfig() {
  if (!fs.existsSync(TEXT_SCROLL_CONFIG_PATH)) return;

  try {
    const loaded = JSON.parse(fs.readFileSync(TEXT_SCROLL_CONFIG_PATH));
    state.textScrollConfig = { ...state.textScrollConfig, ...loaded };
    console.log(`[HTTP] text-scroll-config.json 로드 완료 - ${JSON.stringify(state.textScrollConfig)}`);
  } catch (err) {
    console.error('[HTTP] text-scroll-config.json 파싱 실패 - 기본값 유지:', err.message);
  }
}

loadTextScrollConfig();

// textPatternConfig를 text-pattern-config.json에 저장한다 (POST /api/text-pattern/config 호출 시마다).
function saveTextPatternConfig() {
  try {
    fs.mkdirSync(path.dirname(TEXT_PATTERN_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEXT_PATTERN_CONFIG_PATH, JSON.stringify(state.textPatternConfig, null, 2));
  } catch (err) {
    console.error('[HTTP] text-pattern-config.json 저장 실패:', err.message);
  }
}

// 서버 시작 시 저장된 textPatternConfig가 있으면 불러온다 (loadTextScrollConfig와 동일 패턴).
function loadTextPatternConfig() {
  if (!fs.existsSync(TEXT_PATTERN_CONFIG_PATH)) return;

  try {
    const loaded = JSON.parse(fs.readFileSync(TEXT_PATTERN_CONFIG_PATH));
    state.textPatternConfig = { ...state.textPatternConfig, ...loaded };
    console.log(`[HTTP] text-pattern-config.json 로드 완료 - ${JSON.stringify(state.textPatternConfig)}`);
  } catch (err) {
    console.error('[HTTP] text-pattern-config.json 파싱 실패 - 기본값 유지:', err.message);
  }
}

loadTextPatternConfig();

// deployConfig를 deploy-config.json에 저장한다 (POST /api/deploy-config 호출 시마다).
function saveDeployConfig() {
  try {
    fs.mkdirSync(path.dirname(DEPLOY_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(DEPLOY_CONFIG_PATH, JSON.stringify(state.deployConfig, null, 2));
  } catch (err) {
    console.error('[HTTP] deploy-config.json 저장 실패:', err.message);
  }
}

// 서버 시작 시 저장된 deployConfig가 있으면 불러온다 (loadTextScrollConfig와 동일 패턴).
function loadDeployConfig() {
  if (!fs.existsSync(DEPLOY_CONFIG_PATH)) return;

  try {
    const loaded = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_PATH));
    state.deployConfig = { ...state.deployConfig, ...loaded };
    console.log(`[HTTP] deploy-config.json 로드 완료 - ${JSON.stringify(state.deployConfig)}`);
  } catch (err) {
    console.error('[HTTP] deploy-config.json 파싱 실패 - 기본값 유지:', err.message);
  }
}

loadDeployConfig();

// ── 기기 온라인 상태 ──────────────────────────────────
// deviceId(문자열) -> 마지막 heartbeat 수신 시각(epoch ms)
const deviceLastSeen = {};
// deviceId(문자열) -> heartbeat에 실려온 앱 versionCode. OTA 진행상황(wall/ota/status)과
// 달리 "지금 이 순간 실제로 실행 중인 버전"을 알려준다 - 재부팅 등으로 시간이 지난 뒤에도
// heartbeat마다 계속 갱신되므로 대시보드 버전 확인 토글의 근거로 쓴다.
const deviceVersion = {};

function isDeviceOnline(deviceId) {
  const lastSeen = deviceLastSeen[deviceId];
  return lastSeen !== undefined && Date.now() - lastSeen < OFFLINE_TIMEOUT_MS;
}

// ── 배포 매니페스트 (파일 수신 검증의 기준값) ────────────
// gen_manifest.py가 만든 manifest.json - deviceId별 기대 체크섬/SSID/영상 파일명을 담고 있다.
let manifest = null;
// deviceId(숫자/문자 모두 커버되도록 매니페스트의 deviceId 그대로) -> manifest의 device 항목
let manifestByDeviceId = {};

// deviceId -> 폰이 wall/ready 또는 wall/error로 보고한 최신 파일 상태
// { status: 'ok' | 'mismatch', checksum, reason?, reportedAt }
const deviceFileState = {};

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log(
      `[HTTP] ${MANIFEST_PATH} 없음 - 파일 배포/검증 기능 비활성 상태. ` +
      'pipeline/slicer/deploy.py (또는 gen_manifest.py) 실행 여부 확인 - ' +
      'videos/slice_manifest.json만 있고 이 경로의 manifest.json이 없는 게 흔한 원인입니다.',
    );
    manifest = null;
    manifestByDeviceId = {};
    return;
  }

  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH));
    manifestByDeviceId = {};
    for (const device of manifest.devices) {
      manifestByDeviceId[device.deviceId] = device;
    }
    console.log(`[HTTP] manifest.json 로드 완료 - 디바이스 ${manifest.devices.length}대`);
  } catch (err) {
    console.error('[HTTP] manifest.json 파싱 실패:', err.message);
  }
}

loadManifest();

// manifest의 devices[].meta.row를 세서 행별 디바이스 수 배열을 만든다. 텍스트 스크롤이
// "전체 배너에서 내 몫이 어디인지" 계산하는 기준값 - 100대는 전부 20이지만, 구체처럼
// 위도(행)마다 대수가 다른 레이아웃도 이 배열 하나로 표현된다(인덱스 = row).
function computeRowCounts() {
  if (!manifest) return null;

  const counts = {};
  let maxRow = -1;
  for (const device of manifest.devices) {
    const row = device.meta && device.meta.row;
    if (row === undefined || row === null) continue;
    counts[row] = (counts[row] || 0) + 1;
    if (row > maxRow) maxRow = row;
  }
  if (maxRow < 0) return null;

  const rowCounts = [];
  for (let r = 0; r <= maxRow; r += 1) {
    rowCounts.push(counts[r] || 0);
  }
  return rowCounts;
}

// sphere 텍스트 스크롤의 가로 캔버스 폭(gridWidthPx)에 쓸 "대표" gapRatioX 하나를 구한다.
// sphere는 gapRatioX가 위도(행)마다 다른데(적도 ~0.39, 극지방 ~0.55), 각 폰이 자기
// 행 값을 쓰면 폰마다 캔버스 폭이 달라져 스크롤 진행률이 어긋나는 문제가 있었다
// (TextScrollView.kt 참고 - 그래서 한때 gap 보정을 아예 뺐었음). 대신 gridCols와
// 같은 기준(가장 넓은 행)의 gapRatioX 하나를 서버가 뽑아 전 폰에 방송하면, 모든 폰이
// 같은 값으로 계산해서 싱크는 유지하면서 간격 보정도 되살릴 수 있다.
// flat은 gapRatioX가 device.meta에 없으므로(매니페스트 최상위 gap 필드를 쓰는 구조)
// 여기선 못 찾고 0을 반환하는데, flat은 애초에 이 값을 안 쓰므로 문제 없다.
function computeRefGapRatioX(rowCounts) {
  if (!manifest || !rowCounts || rowCounts.length === 0) return 0;
  const maxCount = Math.max(...rowCounts);
  const refRow = rowCounts.indexOf(maxCount);
  const device = manifest.devices.find(
    (d) => d.meta && d.meta.row === refRow && typeof d.meta.gapRatioX === 'number',
  );
  return device ? device.meta.gapRatioX : 0;
}

// 위도 0도(적도)에 해당하는 행 인덱스를 찾는다 - 텍스트 스크롤 세로 중앙 정렬용.
// 439대 배치는 남/북 비대칭(북 5행 + 남 6행)이라 totalRows/2로 기하학적 중앙을 잡으면
// 적도보다 살짝 남쪽으로 치우친다(TextScrollView.kt 참고) - 그래서 행 개수가 아니라
// 실제 위도가 0에 가장 가까운 행을 직접 찾아서 그 행에 중앙을 맞춘다.
// flat은 meta에 lat이 없으므로 null을 반환한다(flat은 기존 totalRows 기준 중앙을 그대로 씀).
function computeCenterRow() {
  if (!manifest) return null;
  let best = null;
  for (const device of manifest.devices) {
    const lat = device.meta && device.meta.lat;
    const row = device.meta && device.meta.row;
    if (typeof lat !== 'number' || typeof row !== 'number') continue;
    if (best === null || Math.abs(lat) < Math.abs(best.lat)) best = { lat, row };
  }
  return best ? best.row : null;
}

// 폰이 wall/ready/{deviceId}로 보고한 체크섬을 manifest의 기대값과 비교해 상태를 기록한다.
function handleFileReady(deviceId, payload) {
  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch (err) {
    console.error(`[MQTT] wall/ready/${deviceId} 파싱 실패:`, err.message);
    return;
  }

  const expected = manifestByDeviceId[deviceId];
  const ok = Boolean(expected && expected.checksum && msg.checksum === expected.checksum);

  deviceFileState[deviceId] = {
    status: ok ? 'ok' : 'mismatch',
    checksum: msg.checksum,
    reportedAt: Date.now(),
  };
  console.log(`[MQTT] wall/ready/${deviceId} 수신 - ${ok ? 'ok' : 'mismatch'} (checksum=${msg.checksum})`);
}

// 폰이 wall/error/{deviceId}로 보고한 다운로드/검증 실패를 기록한다 (원인 파싱 실패해도 mismatch로 취급).
function handleFileError(deviceId, payload) {
  let msg = {};
  try {
    msg = JSON.parse(payload.toString());
  } catch (err) {
    msg = { reason: 'PARSE_FAILED', detail: payload.toString() };
  }

  deviceFileState[deviceId] = {
    status: 'mismatch',
    checksum: null,
    reason: msg.reason,
    reportedAt: Date.now(),
  };
  console.log(`[MQTT] wall/error/${deviceId} 수신 - ${msg.reason || '(사유 없음)'} ${msg.detail || ''}`);
}

// 대시보드에 노출할 3단계 상태. 응답 없음(무응답/heartbeat 끊김)이 체크섬 불일치보다 먼저 판정된다 -
// 오프라인 상태에서 온 오래된 ready/error 보고를 "정상"으로 오인하지 않기 위함.
function computeFileStatus(deviceId) {
  if (!manifest) return 'unknown';
  if (!isDeviceOnline(deviceId)) return 'unknown';

  const reported = deviceFileState[deviceId];
  if (!reported) return 'unknown'; // 온라인이지만 아직 ready/error 보고가 한 번도 없음
  return reported.status;
}

// manifest의 폰별 config.json을 wall/device/{deviceId}에 retain 발행한다.
// wall/state/color와 같은 패턴 - 늦게 접속/재부팅한 폰도 자동으로 최신 config를 받는다.
function publishDeviceConfigs() {
  if (!manifest) {
    console.error('[MQTT] manifest 없음 - wall/device 발행 생략');
    return 0;
  }

  let count = 0;
  for (const device of manifest.devices) {
    const configPath = path.join(CONFIGS_DIR, `${device.deviceId}.json`);
    if (!fs.existsSync(configPath)) {
      console.error(`[MQTT] config 파일 없음, 발행 생략 - deviceId=${device.deviceId}`);
      continue;
    }

    const payload = fs.readFileSync(configPath, 'utf-8');
    const topic = `${MQTT_DEVICE_TOPIC_PREFIX}${device.deviceId}`;
    mqttClient.publish(topic, payload, { retain: true, qos: 1 }, (err) => {
      if (err) console.error(`[MQTT] ${topic} 발행 오류:`, err.message);
    });
    count += 1;
  }
  return count;
}

// ── APK 버전 정보 (OTA) ──────────────────────────────
// publish-apk.js가 쓰는 app-version.json을 매 요청마다 새로 읽는다 (loadManifest처럼
// 시작 시 한 번만 캐시하지 않음 - publish-apk.js는 서버와 별도 프로세스로 실행되므로).
function readAppVersion() {
  if (!fs.existsSync(APK_VERSION_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(APK_VERSION_PATH));
  } catch (err) {
    console.error('[HTTP] app-version.json 파싱 실패:', err.message);
    return null;
  }
}

// deviceId -> 폰이 wall/ota/status/{deviceId}로 보고한 최신 OTA 진행 상태
// { versionCode, phase: 'downloading'|'installing'|'done'|'failed', reason?, reportedAt }
const deviceOtaState = {};

function handleOtaStatus(deviceId, payload) {
  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch (err) {
    console.error(`[MQTT] wall/ota/status/${deviceId} 파싱 실패:`, err.message);
    return;
  }

  deviceOtaState[deviceId] = {
    versionCode: msg.versionCode,
    phase: msg.phase,
    reason: msg.reason,
    reportedAt: Date.now(),
  };
  console.log(
    `[MQTT] wall/ota/status/${deviceId} 수신 - phase=${msg.phase} versionCode=${msg.versionCode}`
    + (msg.reason ? ` reason=${msg.reason}` : ''),
  );
}

// ── UDP 멀티캐스트 소켓 초기화 ───────────────────────
const udpSocket = dgram.createSocket('udp4');

udpSocket.bind(() => {
  udpSocket.setMulticastTTL(2);
  udpSocket.setMulticastLoopback(true);
  console.log(`[UDP] 멀티캐스트 소켓 초기화 완료 (${MULTICAST_ADDR}:${MULTICAST_PORT}, ${FPS}fps)`);
});

udpSocket.on('error', (err) => {
  console.error('[UDP] 소켓 오류:', err);
});

// 30fps로 타임코드 패킷 발송 (재생 여부와 무관하게 항상 발송)
// PLAY/STOP 제어는 더 이상 이 패킷에 싣지 않고 MQTT(wall/control)로 별도 발행한다.
let tickCount = 0;

function broadcastTimecode() {
  const masterMs = Date.now();
  const elapsedMs = state.isPlaying
    ? Math.max(0, masterMs - state.startAt)
    : state.stoppedElapsedMs;

  const packet = {
    type: 'TIMECODE',
    masterMs,
    elapsedMs,
    startAt: state.startAt,
  };

  const buf = Buffer.from(JSON.stringify(packet));
  udpSocket.send(buf, 0, buf.length, MULTICAST_PORT, MULTICAST_ADDR, (err) => {
    if (err) console.error('[UDP] 전송 오류:', err);
  });

  // 매 프레임 로그는 너무 많으므로 1초(30틱)마다 한 번만 출력
  tickCount += 1;
  if (tickCount % FPS === 0) {
    console.log(`[UDP] 타임코드 발송 중 - elapsedMs=${elapsedMs}`);
  }
}

setInterval(broadcastTimecode, TICK_MS);

// ── MQTT 연결 (Mosquitto) ────────────────────────────
// 브로커가 아직 안 떠 있어도 크래시하지 않고 자동 재연결을 계속 시도한다.
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  reconnectPeriod: 2000,
});

mqttClient.on('connect', () => {
  console.log(`[MQTT] 브로커 연결 완료 - ${MQTT_BROKER_URL}`);

  mqttClient.subscribe(MQTT_STATUS_TOPIC_FILTER, (err) => {
    if (err) console.error('[MQTT] wall/status 구독 오류:', err.message);
    else console.log(`[MQTT] ${MQTT_STATUS_TOPIC_FILTER} 구독 완료`);
  });

  mqttClient.subscribe(MQTT_READY_TOPIC_FILTER, (err) => {
    if (err) console.error('[MQTT] wall/ready 구독 오류:', err.message);
    else console.log(`[MQTT] ${MQTT_READY_TOPIC_FILTER} 구독 완료`);
  });

  mqttClient.subscribe(MQTT_ERROR_TOPIC_FILTER, (err) => {
    if (err) console.error('[MQTT] wall/error 구독 오류:', err.message);
    else console.log(`[MQTT] ${MQTT_ERROR_TOPIC_FILTER} 구독 완료`);
  });

  mqttClient.subscribe(MQTT_OTA_STATUS_TOPIC_FILTER, (err) => {
    if (err) console.error('[MQTT] wall/ota/status 구독 오류:', err.message);
    else console.log(`[MQTT] ${MQTT_OTA_STATUS_TOPIC_FILTER} 구독 완료`);
  });
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] 브로커 재연결 시도 중...');
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] 오류:', err.message);
});

// wall/status/{id} heartbeat 수신 - 존재 자체가 heartbeat이므로 파싱 실패해도 무시하고
// lastSeen은 갱신한다. versionCode가 있으면 "지금 실행 중인 버전"으로 별도 기록한다.
mqttClient.on('message', (topic, payload) => {
  const statusMatch = topic.match(/^wall\/status\/(\d+)$/);
  if (statusMatch) {
    deviceLastSeen[statusMatch[1]] = Date.now();
    try {
      const msg = JSON.parse(payload.toString());
      if (typeof msg.versionCode === 'number') {
        deviceVersion[statusMatch[1]] = msg.versionCode;
      }
    } catch (err) {
      // 구버전 앱은 versionCode를 안 보낼 수 있음 - heartbeat 자체는 유효하므로 무시
    }
    return;
  }

  const readyMatch = topic.match(/^wall\/ready\/(\d+)$/);
  if (readyMatch) {
    handleFileReady(readyMatch[1], payload);
    return;
  }

  const errorMatch = topic.match(/^wall\/error\/(\d+)$/);
  if (errorMatch) {
    handleFileError(errorMatch[1], payload);
    return;
  }

  const otaStatusMatch = topic.match(/^wall\/ota\/status\/(\d+)$/);
  if (otaStatusMatch) {
    handleOtaStatus(otaStatusMatch[1], payload);
  }
});

// wall/control에 제어 명령을 발행한다. 기본은 retain: true로 발행해서
// 늦게 접속하거나 재연결한 폰도 마지막 상태(PLAY/STOP/모드)를 즉시 받을 수 있게 한다.
// PATTERN_START/STOP처럼 "지금 이 순간의 동작"을 의미하는 명령은 retain: false로 발행한다.
function publishControl(payload, { retain = true } = {}) {
  const message = JSON.stringify(payload);
  mqttClient.publish(MQTT_CONTROL_TOPIC, message, { retain, qos: 1 }, (err) => {
    if (err) {
      console.error('[MQTT] 발행 오류:', err.message);
    } else {
      console.log(`[MQTT] ${MQTT_CONTROL_TOPIC} 발행 (retain=${retain}) - ${message}`);
    }
  });
}

// 현재 컬러 상태를 지운다 - state 초기화 + COLOR_CLEAR 발행(non-retain) + wall/state/color
// retain 삭제를 한 곳에서 처리한다. /api/color-reset(대시보드)과 /api/color-clear(키오스크)가 공유한다.
function clearCurrentColor(leadTime) {
  state.currentColor = { color: null, stress: null };
  const startAt = Date.now() + leadTime;
  publishControl({ type: 'COLOR_CLEAR', startAt }, { retain: false });
  publishColorState();
  return startAt;
}

// wall/state/color에 "현재 컬러 상태"를 retain으로 발행한다 (startAt 없음).
// 늦게 접속하거나 재부팅한 폰은 이미 지나간 startAt이 있는 COLOR_CHANGE(non-retain)를 받을 수
// 없으므로, 대신 이 retained 상태를 받아 애니메이션 없이 즉시 현재 색으로 맞춘다.
// color가 null이면 빈 페이로드로 발행한다 - MQTT에서 retain:true + 빈 페이로드는
// "이 토픽의 retained 메시지를 삭제하라"는 표준 관용구다.
function publishColorState() {
  const { color, stress } = state.currentColor;
  const message = color ? JSON.stringify({ color, stress }) : '';
  mqttClient.publish(MQTT_COLOR_STATE_TOPIC, message, { retain: true, qos: 1 }, (err) => {
    if (err) {
      console.error('[MQTT] 발행 오류:', err.message);
    } else {
      console.log(`[MQTT] ${MQTT_COLOR_STATE_TOPIC} 발행 (retain) - ${message || '(삭제)'}`);
    }
  });
}

// wall/ota에 새 버전 정보를 retain으로 발행한다. wall/state/color와 같은 이유로 retain -
// 재접속/재부팅한 폰도 "지금 최신 버전이 뭔지"는 즉시 알아야 한다.
// 주의: MQTT 인증이 없는 상태라, 이 토픽에 발행 가능한 사람은 누구나 url+sha256을
// 자기 것끼리 짝지어 임의 APK를 설치시킬 수 있다. 진짜 보안이 필요해지면 브로커 인증부터.
function publishOtaUpdate(message) {
  mqttClient.publish(MQTT_OTA_TOPIC, JSON.stringify(message), { retain: true, qos: 1 }, (err) => {
    if (err) {
      console.error(`[MQTT] ${MQTT_OTA_TOPIC} 발행 오류:`, err.message);
    } else {
      console.log(`[MQTT] ${MQTT_OTA_TOPIC} 발행 - versionCode=${message.versionCode} stepDelayMs=${message.stepDelayMs}`);
    }
  });
}

// ── REST API + 대시보드 정적 파일 ─────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// 폰이 다운로드하는 영상 파일 - gen_manifest.py/gen_configs.py가 채워 넣는 distribute/videos/
app.use('/clips', express.static(VIDEOS_DIR));
// 폰이 다운로드하는 APK - scripts/publish-apk.js가 채워 넣는 apk/
app.use('/apk', express.static(APK_DIR));

// isPlaying = true, startAt = 현재 시각으로 세팅하고 MQTT PLAY 명령을 발행한다.
// /api/play(대시보드)와 playbackWss(외부 재생 신호 WebSocket)가 공유한다 - 로깅은
// 호출부마다 다르게 남기고 싶어서 여기엔 안 넣는다.
function triggerPlay() {
  state.isPlaying = true;
  state.startAt = Date.now();
  tickCount = 0;
  publishControl({ type: 'PLAY', startAt: state.startAt });
  return state.startAt;
}

// 재생 시작: isPlaying = true, startAt = 현재 시각. MQTT로 PLAY 명령도 함께 발행한다.
app.post('/api/play', (req, res) => {
  const startAt = triggerPlay();

  console.log(`[HTTP] 재생 시작 - startAt=${startAt}`);
  res.json({ success: true, state });
});

// 재생 정지: isPlaying = false, 정지 시점의 elapsedMs를 고정해둔다. MQTT로 STOP 명령도 함께 발행한다.
app.post('/api/stop', (req, res) => {
  if (state.isPlaying) {
    state.stoppedElapsedMs = Math.max(0, Date.now() - state.startAt);
  }
  state.isPlaying = false;

  // elapsedMs를 함께 실어 보낸다 - retain된 STOP을 나중에 받는 폰도
  // 정지된 위치(elapsedMs % duration)로 seek해서 다른 폰들과 같은 프레임을 보여줄 수 있게 한다.
  publishControl({ type: 'STOP', elapsedMs: state.stoppedElapsedMs });

  console.log(`[HTTP] 재생 정지 - stoppedElapsedMs=${state.stoppedElapsedMs}`);
  res.json({ success: true, state });
});

// 모드 전환: "video" | "pattern" | "text". MQTT로 MODE_VIDEO/MODE_PATTERN/MODE_TEXT를 retain 발행한다.
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!MODE_MQTT_TYPES[mode]) {
    res.status(400).json({ success: false, error: 'mode는 "video", "pattern", "text" 중 하나여야 합니다.' });
    return;
  }

  state.currentMode = mode;
  publishControl({ type: MODE_MQTT_TYPES[mode] });

  console.log(`[HTTP] 모드 전환 - ${mode}`);
  res.json({ success: true, state });
});

// 패턴 설정 저장 (발행하지 않음 - PATTERN_START 시점에 이 값을 사용한다)
app.post('/api/pattern/config', (req, res) => {
  const { color, interval, duration, stepDelay } = req.body;
  if (color !== undefined) state.patternConfig.color = color;
  if (interval !== undefined) state.patternConfig.interval = interval;
  if (duration !== undefined) state.patternConfig.duration = duration;
  if (stepDelay !== undefined) state.patternConfig.stepDelay = stepDelay;
  savePatternConfig();

  console.log(`[HTTP] 패턴 설정 저장 - ${JSON.stringify(state.patternConfig)}`);
  res.json({ success: true, patternConfig: state.patternConfig });
});

// 패턴(점멸) 시작 - 500ms 뒤를 startAt으로 잡아 폰들이 동시에 시작할 여유를 준다.
app.post('/api/pattern/start', (req, res) => {
  publishControl(
    {
      type: 'PATTERN_START',
      color: state.patternConfig.color,
      interval: state.patternConfig.interval,
      duration: state.patternConfig.duration,
      startAt: Date.now() + 500,
    },
    { retain: false },
  );

  console.log('[HTTP] 패턴 시작');
  res.json({ success: true, patternConfig: state.patternConfig });
});

// 패턴(점멸) 정지 - 마지막 색상은 폰 쪽에서 유지한다.
app.post('/api/pattern/stop', (req, res) => {
  publishControl({ type: 'PATTERN_STOP' }, { retain: false });

  console.log('[HTTP] 패턴 정지');
  res.json({ success: true });
});

// 텍스트 스크롤 설정 저장 (발행하지 않음 - TEXT_SCROLL 시점에 이 값을 사용한다)
app.post('/api/text/config', (req, res) => {
  const { text, font, fontSize, color, bgColor, align, direction, speed } = req.body;
  if (text !== undefined) state.textScrollConfig.text = text;
  if (font !== undefined) state.textScrollConfig.font = font;
  if (fontSize !== undefined) state.textScrollConfig.fontSize = fontSize;
  if (color !== undefined) state.textScrollConfig.color = color;
  if (bgColor !== undefined) state.textScrollConfig.bgColor = bgColor;
  if (align !== undefined) state.textScrollConfig.align = align;
  if (direction !== undefined) state.textScrollConfig.direction = direction;
  if (speed !== undefined) state.textScrollConfig.speed = speed;
  saveTextScrollConfig();

  console.log(`[HTTP] 텍스트 설정 저장 - ${JSON.stringify(state.textScrollConfig)}`);
  res.json({ success: true, textScrollConfig: state.textScrollConfig });
});

// 텍스트 스크롤 시작 - manifest의 row별 디바이스 수(rowCounts)를 계산해서 함께 발행한다.
// 각 폰은 자기 row/col(config.json에 배포 시점에 저장돼 있음)과 이 rowCounts를 가지고
// 전체 배너 중 자기 몫만 그린다.
app.post('/api/text/start', (req, res) => {
  const rowCounts = computeRowCounts();
  if (!rowCounts) {
    res.status(400).json({
      ok: false,
      error: 'manifest가 없거나 devices[].meta.row 정보가 없습니다 - '
        + 'deploy.py/gen_manifest.py 실행 및 /api/distribute/publish 발행 여부를 확인하세요.',
    });
    return;
  }

  const cfg = state.textScrollConfig;
  const centerRow = computeCenterRow();
  const message = {
    type: 'TEXT_SCROLL',
    text: cfg.text,
    font: cfg.font,
    fontSize: cfg.fontSize,
    color: cfg.color,
    bgColor: cfg.bgColor,
    align: cfg.align,
    direction: cfg.direction,
    speed: cfg.speed,
    rowCounts,
    totalRows: rowCounts.length,
    refGapRatioX: computeRefGapRatioX(rowCounts),
    // flat은 null이라 필드 자체를 안 넣는다 - 폰이 필드 유무로 flat/sphere를 구분한다
    // (있으면 sphere, 없으면 flat 기존 방식 - null을 넣으면 org.json의 has()가 true를
    // 반환해서 getInt가 실패하므로 아예 필드를 빼야 한다).
    ...(centerRow !== null ? { centerRow } : {}),
    startAt: Date.now() + DEFAULT_TEXT_LEAD_TIME_MS,
  };
  publishControl(message, { retain: false });

  console.log(`[HTTP] 텍스트 스크롤 시작 - totalRows=${rowCounts.length} direction=${cfg.direction}`);
  res.json({ ok: true, ...message });
});

app.post('/api/text/stop', (req, res) => {
  publishControl({ type: 'TEXT_STOP' }, { retain: false });

  console.log('[HTTP] 텍스트 스크롤 정지');
  res.json({ ok: true });
});

// 텍스트 패턴 설정 저장 (발행하지 않음 - /api/text-pattern/start 시점에 이 값을 사용한다)
app.post('/api/text-pattern/config', (req, res) => {
  const { text, fgColor, bgColor, charStaggerMs, fadeInMs, holdMs, fadeOutMs } = req.body;
  if (text !== undefined) state.textPatternConfig.text = text;
  if (fgColor !== undefined) state.textPatternConfig.fgColor = fgColor;
  if (bgColor !== undefined) state.textPatternConfig.bgColor = bgColor;
  if (charStaggerMs !== undefined) state.textPatternConfig.charStaggerMs = charStaggerMs;
  if (fadeInMs !== undefined) state.textPatternConfig.fadeInMs = fadeInMs;
  if (holdMs !== undefined) state.textPatternConfig.holdMs = holdMs;
  if (fadeOutMs !== undefined) state.textPatternConfig.fadeOutMs = fadeOutMs;
  saveTextPatternConfig();

  console.log(`[HTTP] 텍스트 패턴 설정 저장 - ${JSON.stringify(state.textPatternConfig)}`);
  res.json({ success: true, textPatternConfig: state.textPatternConfig });
});

// 순환 중인 텍스트 패턴의 "다음 단어 예약" 타이머 - /api/text-pattern/stop이나
// 새 /api/text-pattern/start가 오면 반드시 clearTimeout해야 한다. 안 그러면 정지시켜도
// 예약된 다음 단어가 나중에 튀어나온다.
let textPatternTimer = null;

// 단어 하나를 지금 표시하고, 그 단어의 페이드아웃이 끝나는 시각에 다음 단어(순환)를
// 예약한다. manifest의 row/col을 비트맵과 대조해 폰별로 다른 색을 wall/pattern/{deviceId}에
// 개별 발행한다(COLOR_CHANGE와 달리 전체 방송이 아니라 폰마다 다름). 전경(글자) 셀은
// charIndex별로 시차를 둔 fadeInAt과, 모든 글자가 다 켜진 뒤 공유하는 fadeOutAt을 함께
// 보낸다 - 폰은 이 절대 시각 두 개만으로 로컬 애니메이션을 돌린다(단어가 바뀔 때마다
// 새 메시지가 오면 Android TextPatternAnimator가 진행 중이던 이전 애니메이션을 알아서
// 취소하고 새로 시작하므로, 서버는 그냥 다음 단어를 발행하기만 하면 된다).
function dispatchTextPatternWord(words, index) {
  if (!manifest) {
    console.error('[HTTP] 텍스트 패턴 순환 중단 - manifest 없음');
    return 0;
  }
  const rowCounts = computeRowCounts();
  if (!rowCounts) {
    console.error('[HTTP] 텍스트 패턴 순환 중단 - devices[].meta.row 정보 없음');
    return 0;
  }
  const gridCols = Math.max(...rowCounts);
  const totalRows = rowCounts.length;

  const cfg = state.textPatternConfig;
  const word = words[index % words.length];
  const { grid, numChars } = computeTextPatternGrid(word, gridCols, totalRows);

  const baseStartAt = Date.now() + DEFAULT_TEXT_PATTERN_LEAD_TIME_MS;
  const fadeOutAt = baseStartAt + Math.max(0, numChars - 1) * cfg.charStaggerMs + cfg.fadeInMs + cfg.holdMs;

  let count = 0;
  for (const device of manifest.devices) {
    const row = device.meta && device.meta.row;
    const col = device.meta && device.meta.col;
    if (row === undefined || row === null || col === undefined || col === null) continue;

    const charIndex = grid[row] !== undefined ? grid[row][col] : -1;
    const topic = `${MQTT_PATTERN_CELL_TOPIC_PREFIX}${device.deviceId}`;

    const payload = charIndex >= 0
      ? {
        type: 'TEXT_PATTERN_CELL',
        color: cfg.fgColor,
        fadeInAt: baseStartAt + charIndex * cfg.charStaggerMs,
        fadeInMs: cfg.fadeInMs,
        fadeOutAt,
        fadeOutMs: cfg.fadeOutMs,
      }
      : { type: 'TEXT_PATTERN_CELL', color: cfg.bgColor };

    mqttClient.publish(topic, JSON.stringify(payload), { retain: false, qos: 1 }, (err) => {
      if (err) console.error(`[MQTT] ${topic} 발행 오류:`, err.message);
    });
    count += 1;
  }

  console.log(`[HTTP] 텍스트 패턴 표시 - word="${word}" (${(index % words.length) + 1}/${words.length}) 대상 ${count}대`);

  const cycleEndAt = fadeOutAt + cfg.fadeOutMs;
  textPatternTimer = setTimeout(() => {
    dispatchTextPatternWord(words, index + 1);
  }, Math.max(0, cycleEndAt - Date.now()));

  return count;
}

// 텍스트 패턴 시작 - textPatternConfig.text를 줄바꿈으로 나눠 여러 단어로 취급한다.
// 첫 단어가 페이드아웃까지 끝나면 자동으로 다음 단어를 이어서 표시하고, 마지막 단어
// 다음엔 다시 첫 단어로 돌아가 계속 순환한다(설치 전시 특성상 무한 반복이 기본).
app.post('/api/text-pattern/start', (req, res) => {
  if (!manifest) {
    res.status(400).json({
      ok: false,
      error: 'manifest가 없습니다 - deploy.py/gen_manifest.py 실행 및 /api/distribute/publish 발행 여부를 확인하세요.',
    });
    return;
  }

  const rowCounts = computeRowCounts();
  if (!rowCounts) {
    res.status(400).json({ ok: false, error: 'devices[].meta.row 정보가 없습니다.' });
    return;
  }

  const words = state.textPatternConfig.text.split('\n').map((w) => w.trim()).filter((w) => w.length > 0);
  if (words.length === 0) {
    res.status(400).json({ ok: false, error: '표시할 텍스트가 없습니다.' });
    return;
  }

  if (textPatternTimer) clearTimeout(textPatternTimer);
  const count = dispatchTextPatternWord(words, 0);

  console.log(`[HTTP] 텍스트 패턴 시작 - 단어 ${words.length}개 순환 재생, 대상 ${count}대`);
  res.json({ ok: true, words, targets: count });
});

app.post('/api/text-pattern/stop', (req, res) => {
  if (textPatternTimer) {
    clearTimeout(textPatternTimer);
    textPatternTimer = null;
  }
  publishControl({ type: 'TEXT_PATTERN_STOP' }, { retain: false });

  console.log('[HTTP] 텍스트 패턴 정지');
  res.json({ ok: true });
});

// 순차 점멸 시작 - 폰마다 deviceId 순서대로 stepDelay만큼 늦게 시작한다.
// totalDevices는 현재 online 상태인 기기 수만 센다.
app.post('/api/sequence/start', (req, res) => {
  const totalDevices = Object.keys(deviceLastSeen).filter((id) => isDeviceOnline(id)).length;

  publishControl(
    {
      type: 'SEQUENCE_START',
      color: state.patternConfig.color,
      interval: state.patternConfig.interval,
      duration: state.patternConfig.duration,
      stepDelay: state.patternConfig.stepDelay,
      startAt: Date.now() + 500,
      totalDevices,
    },
    { retain: false },
  );

  console.log(`[HTTP] 순차 점멸 시작 - totalDevices=${totalDevices}`);
  res.json({ success: true, patternConfig: state.patternConfig, totalDevices });
});

// 순차 점멸 정지
app.post('/api/sequence/stop', (req, res) => {
  publishControl({ type: 'SEQUENCE_STOP' }, { retain: false });

  console.log('[HTTP] 순차 점멸 정지');
  res.json({ success: true });
});

// 전체 폰에 deviceId 큰 숫자 표시 - 특정 폰이 아니라 방송이라 별도 대상 지정은 없다.
// 물리 설치/점검 시 "이 화면이 몇 번 폰인지" 확인하는 용도.
app.post('/api/show-id', (req, res) => {
  const { duration } = req.body || {};
  const finalDuration = duration !== undefined ? Number(duration) : DEFAULT_SHOW_ID_DURATION_MS;
  if (!Number.isFinite(finalDuration) || finalDuration < 0) {
    res.status(400).json({ ok: false, error: 'duration은 0 이상 숫자여야 합니다.' });
    return;
  }

  publishControl({ type: 'SHOW_ID', duration: finalDuration }, { retain: false });

  console.log(`[HTTP] ID 표시 - duration=${finalDuration}`);
  res.json({ ok: true, duration: finalDuration });
});

// ID 표시 끄기 - duration:0(상시 표시)으로 켠 걸 끌 때 쓴다. 대시보드의 켜기/끄기 토글이 공유.
app.post('/api/hide-id', (req, res) => {
  publishControl({ type: 'HIDE_ID' }, { retain: false });

  console.log('[HTTP] ID 표시 끄기');
  res.json({ ok: true });
});

// 앱 재시작(Activity recreate). targetDeviceIds를 안 주면 전체, 주면 그 deviceId들만 -
// SEQUENCE_START와 같은 패턴으로 브로드캐스트하고 폰이 자기 deviceId로 스스로 걸러낸다.
// 앱이 멈추거나 이상 동작할 때, 또는 wall/device 갱신이 재생 중이라 반영을 못 하고
// 미뤄진 채로 남아있을 때(정지 전까지 계속 보류됨) 강제로 풀어주는 용도로도 쓸 수 있다.
app.post('/api/restart-app', (req, res) => {
  const { targetDeviceIds } = req.body || {};
  if (targetDeviceIds !== undefined && !Array.isArray(targetDeviceIds)) {
    res.status(400).json({ ok: false, error: 'targetDeviceIds는 배열이어야 합니다.' });
    return;
  }

  const payload = { type: 'RESTART_APP' };
  if (targetDeviceIds !== undefined) payload.targetDeviceIds = targetDeviceIds;
  publishControl(payload, { retain: false });

  console.log(`[HTTP] 앱 재시작 요청 - ${targetDeviceIds ? `대상 ${targetDeviceIds.length}대(${targetDeviceIds.join(',')})` : '전체'}`);
  res.json({ ok: true, targetDeviceIds: targetDeviceIds || null });
});

// 스트레스 컬러 오버레이 전환. stress 또는 color 중 하나는 필수, 둘 다 오면 color 우선.
// startAt = 지금 + leadTime(기본 2000ms)으로 잡아 네트워크/MQTT 전파 지연을 흡수한다.
app.post('/api/color-change', (req, res) => {
  const { stress, color, duration, leadTime } = req.body;

  if (stress === undefined && color === undefined) {
    res.status(400).json({ ok: false, error: 'stress 또는 color 중 하나는 필수입니다.' });
    return;
  }

  let finalColor;
  let stressValue = null;
  if (color !== undefined) {
    if (typeof color !== 'string' || !HEX_COLOR_RE.test(color)) {
      res.status(400).json({ ok: false, error: 'color는 #RRGGBB 형식이어야 합니다.' });
      return;
    }
    finalColor = color.toUpperCase();
  } else {
    stressValue = Number(stress);
    if (!Number.isFinite(stressValue) || stressValue < 0 || stressValue > 1) {
      res.status(400).json({ ok: false, error: 'stress는 0.0~1.0 사이 숫자여야 합니다.' });
      return;
    }
    finalColor = stressToColor(stressValue);
  }

  const finalDuration = duration !== undefined ? Number(duration) : DEFAULT_COLOR_DURATION_MS;
  if (!Number.isFinite(finalDuration) || finalDuration < 0) {
    res.status(400).json({ ok: false, error: 'duration은 0 이상 숫자여야 합니다.' });
    return;
  }

  const finalLeadTime = leadTime !== undefined ? Number(leadTime) : DEFAULT_COLOR_LEAD_TIME_MS;
  if (!Number.isFinite(finalLeadTime) || finalLeadTime < 0) {
    res.status(400).json({ ok: false, error: 'leadTime은 0 이상 숫자여야 합니다.' });
    return;
  }

  const startAt = Date.now() + finalLeadTime;
  state.currentColor = { color: finalColor, stress: stressValue };

  // COLOR_CHANGE는 retain하지 않는다 - 나중에 접속한 폰이 이미 지나간 startAt을 받으면 안 된다.
  publishControl(
    { type: 'COLOR_CHANGE', color: finalColor, startAt, duration: finalDuration, stress: stressValue, source: 'kiosk' },
    { retain: false },
  );
  // 현재 색 상태는 별도로 retain 발행 - 늦게 접속하는 폰은 이걸로 즉시(애니메이션 없이) 맞춘다.
  publishColorState();

  const targets = Object.keys(deviceLastSeen).filter((id) => isDeviceOnline(id)).length;

  console.log(`[HTTP] 컬러 전환 - color=${finalColor} startAt=${startAt} targets=${targets}`);
  res.json({ ok: true, color: finalColor, startAt, duration: finalDuration, targets });
});

// 컬러 오버레이 초기화 - 대시보드의 "색 초기화" 버튼용. 오버레이 제거 명령을 발행하고
// retain된 wall/state/color도 지운다.
app.post('/api/color-reset', (req, res) => {
  clearCurrentColor(500);

  console.log('[HTTP] 컬러 오버레이 초기화');
  res.json({ ok: true });
});

// 컬러 오버레이 초기화 - 키오스크의 COLOR_CLEAR 리셋 버튼용. leadTime 검증 방식은
// /api/color-change와 동일하게 맞춘다 (기본값 DEFAULT_COLOR_LEAD_TIME_MS).
app.post('/api/color-clear', (req, res) => {
  const { leadTime } = req.body;

  const finalLeadTime = leadTime !== undefined ? Number(leadTime) : DEFAULT_COLOR_LEAD_TIME_MS;
  if (!Number.isFinite(finalLeadTime) || finalLeadTime < 0) {
    res.status(400).json({ ok: false, error: 'leadTime은 0 이상 숫자여야 합니다.' });
    return;
  }

  const startAt = clearCurrentColor(finalLeadTime);

  console.log(`[HTTP] 컬러 리셋(키오스크) - startAt=${startAt}`);
  res.json({ ok: true, startAt });
});

// 폰별 config.json 조회 (디버깅/수동 확인용 - 폰은 wall/device/{deviceId}로 받는다)
app.get('/api/config/:deviceId', (req, res) => {
  const device = manifestByDeviceId[req.params.deviceId];
  if (!device) {
    res.status(404).json({ ok: false, error: `manifest에 deviceId=${req.params.deviceId} 없음` });
    return;
  }

  const configPath = path.join(CONFIGS_DIR, `${device.deviceId}.json`);
  if (!fs.existsSync(configPath)) {
    res.status(404).json({ ok: false, error: `config 파일 없음: ${configPath}` });
    return;
  }
  res.sendFile(configPath);
});

// distribute/manifest.json을 다시 읽고, 폰별 config를 wall/device/{deviceId}(retain)로 재발행한 뒤
// CHECK_UPDATE를 브로드캐스트해 모든 폰이 자기 config/영상 상태를 다시 검사하도록 한다.
app.post('/api/distribute/publish', (req, res) => {
  loadManifest();
  if (!manifest) {
    res.status(400).json({
      ok: false,
      error: `manifest.json이 없습니다: ${MANIFEST_PATH} - `
        + 'pipeline/slicer/deploy.py(또는 gen_manifest.py)를 먼저 실행했는지 확인하세요. '
        + 'slice_video.py가 만드는 videos/slice_manifest.json과는 다른 파일입니다.',
    });
    return;
  }

  const published = publishDeviceConfigs();
  publishControl({ type: 'CHECK_UPDATE' }, { retain: false });

  console.log(`[HTTP] 배포 재발행 - wall/device ${published}건 + CHECK_UPDATE 브로드캐스트`);
  res.json({ ok: true, published, totalDevices: manifest.devices.length });
});

// deployConfig(AP 대수) 조회/저장 - 대시보드 영상 교체 UI가 매번 입력받지 않고 재사용한다.
app.get('/api/deploy-config', (req, res) => {
  res.json({ ok: true, deployConfig: state.deployConfig });
});

app.post('/api/deploy-config', (req, res) => {
  const { apCount } = req.body || {};
  const n = Number(apCount);
  if (!Number.isInteger(n) || n < 1) {
    res.status(400).json({ ok: false, error: 'apCount는 1 이상의 정수여야 합니다.' });
    return;
  }
  state.deployConfig.apCount = n;
  saveDeployConfig();
  console.log(`[HTTP] deployConfig 저장 - apCount=${n}`);
  res.json({ ok: true, deployConfig: state.deployConfig });
});

// ── 대시보드 영상 교체 (업로드 → tiles 생성 → 인코딩 → manifest/config → 발행) ──
// gen_tiles.py/deploy.py를 자식 프로세스로 그대로 호출한다. 진행상황은 대시보드
// WebSocket('/')에 VIDEO_REPLACE_PROGRESS로 실시간 방송한다(단계 + 최근 로그).
let videoReplaceState = { step: 'idle', log: [], error: null };
const VIDEO_REPLACE_LOG_MAX_LINES = 300;

function pushVideoReplaceLog(line) {
  videoReplaceState.log.push(line);
  if (videoReplaceState.log.length > VIDEO_REPLACE_LOG_MAX_LINES) videoReplaceState.log.shift();
  broadcastVideoReplaceState();
}

function setVideoReplaceStep(step, error) {
  videoReplaceState.step = step;
  videoReplaceState.error = error || null;
  broadcastVideoReplaceState();
}

function broadcastVideoReplaceState() {
  const message = JSON.stringify({ type: 'VIDEO_REPLACE_PROGRESS', ...videoReplaceState });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// 자식 프로세스를 실행하고 stdout/stderr를 줄 단위로 로그에 흘려보낸다. 종료코드가
// 0이 아니면 실패로 취급 - deploy.py 자체가 "한 단계라도 실패하면 즉시 멈춘다"는
// 원칙으로 만들어져 있어(README 참고) 여기서도 그대로 따른다.
function runProcess(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    pushVideoReplaceLog(`$ ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { cwd });
    const onOutput = (data) => {
      data.toString().split('\n').filter((line) => line.trim().length > 0)
        .forEach((line) => pushVideoReplaceLog(line));
    };
    proc.stdout.on('data', onOutput);
    proc.stderr.on('data', onOutput);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`종료 코드 ${code}`));
    });
  });
}

// 업로드된 영상 하나로 439대 전체를 다시 자르고 배포한다. mode: 'equirect' | 'frontback'.
// 실패해도 서버는 계속 동작 - videoReplaceState.step='error'로 남아 대시보드에 표시된다.
async function processVideoReplace(mode, uploadedPath) {
  videoReplaceState = { step: 'tiles', log: [], error: null };
  broadcastVideoReplaceState();

  try {
    const target = VIDEO_REPLACE_TARGET_SIZE[mode];
    const tilesPath = path.join(SLICER_DIR, 'tiles', `video_replace_${mode}.json`);
    const tilesArgs = ['gen_tiles.py', 'sphere', '--source', target, '-o', tilesPath];
    if (mode === 'frontback') tilesArgs.push('--front-back');
    await runProcess('python3', tilesArgs, SLICER_DIR);

    setVideoReplaceStep('encoding');
    await runProcess('python3', [
      'deploy.py',
      '-i', uploadedPath,
      '-t', tilesPath,
      '--ap-count', String(state.deployConfig.apCount),
      '--base-config', BASE_CONFIG_PATH,
      '--encoder', 'hevc_nvenc',
    ], SLICER_DIR);

    setVideoReplaceStep('publish');
    loadManifest();
    if (!manifest) throw new Error('deploy.py는 끝났는데 manifest.json을 못 찾았습니다.');
    const published = publishDeviceConfigs();
    publishControl({ type: 'CHECK_UPDATE' }, { retain: false });
    pushVideoReplaceLog(`발행 완료 - wall/device ${published}건 + CHECK_UPDATE 브로드캐스트`);

    setVideoReplaceStep('done');
  } catch (err) {
    console.error('[HTTP] 영상 교체 실패:', err.message);
    setVideoReplaceStep('error', err.message);
  } finally {
    fs.unlink(uploadedPath, () => {}); // 업로드 임시 파일 정리 - 실패해도 무시
  }
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const videoUpload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }, // 8GB - 마스터 영상이 큰 편이라 넉넉히
});

app.post('/api/video/replace', videoUpload.single('video'), (req, res) => {
  const mode = req.body && req.body.mode === 'frontback' ? 'frontback' : 'equirect';

  if (!req.file) {
    res.status(400).json({ ok: false, error: '영상 파일(video)이 필요합니다.' });
    return;
  }
  if (videoReplaceState.step !== 'idle' && videoReplaceState.step !== 'done'
    && videoReplaceState.step !== 'error'
  ) {
    fs.unlink(req.file.path, () => {});
    res.status(409).json({ ok: false, error: '이미 진행 중인 영상 교체 작업이 있습니다.' });
    return;
  }

  console.log(`[HTTP] 영상 교체 시작 - mode=${mode} file=${req.file.originalname} (${req.file.size}B)`);
  res.json({ ok: true, mode });
  processVideoReplace(mode, req.file.path);
});

// 현재 배포된 최신 APK 버전 정보 - 폰은 이걸 직접 쓰지 않고 wall/ota(retain)로 받는다.
// 디버깅/수동 확인, 그리고 외부 도구에서 최신 버전을 조회할 때 쓴다.
app.get('/api/app-version', (req, res) => {
  const version = readAppVersion();
  if (!version) {
    res.status(404).json({ ok: false, error: `app-version.json이 없습니다: ${APK_VERSION_PATH}` });
    return;
  }

  res.json({
    versionCode: version.versionCode,
    versionName: version.versionName,
    url: `${req.protocol}://${req.get('host')}/apk/${version.fileName}`,
    sha256: version.sha256,
  });
});

// scripts/publish-apk.js가 채워둔 최신 버전을 wall/ota로 발행해 전 폰에 업데이트를 트리거한다.
// stepDelayMs로 롤링 배포 간격을 조절한다 - 폰은 SEQUENCE_START와 동일하게
// (deviceId-1)*stepDelayMs 만큼 자기 차례를 스스로 계산해서 기다린다.
app.post('/api/app-deploy', (req, res) => {
  const version = readAppVersion();
  if (!version) {
    res.status(400).json({
      ok: false,
      error: `app-version.json이 없습니다: ${APK_VERSION_PATH} - scripts/publish-apk.js를 먼저 실행하세요.`,
    });
    return;
  }

  const { stepDelayMs } = req.body || {};
  const finalStepDelayMs = stepDelayMs !== undefined ? Number(stepDelayMs) : DEFAULT_OTA_STEP_DELAY_MS;
  if (!Number.isFinite(finalStepDelayMs) || finalStepDelayMs < 0) {
    res.status(400).json({ ok: false, error: 'stepDelayMs는 0 이상 숫자여야 합니다.' });
    return;
  }

  const message = {
    type: 'UPDATE_APK',
    versionCode: version.versionCode,
    versionName: version.versionName,
    url: `${req.protocol}://${req.get('host')}/apk/${version.fileName}`,
    sha256: version.sha256,
    startAt: Date.now() + DEFAULT_OTA_LEAD_TIME_MS,
    stepDelayMs: finalStepDelayMs,
  };
  publishOtaUpdate(message);

  console.log(`[HTTP] OTA 배포 발행 - versionCode=${version.versionCode} stepDelayMs=${finalStepDelayMs}`);
  res.json({ ok: true, ...message });
});

// 현재 상태 조회
app.get('/api/state', (req, res) => {
  const elapsedMs = state.isPlaying ? Math.max(0, Date.now() - state.startAt) : state.stoppedElapsedMs;

  res.json({ ...state, elapsedMs });
});

// 서버-폰 시간 오프셋 측정용 - 폰의 TimeSyncManager가 RTT 계산에 사용한다
app.get('/api/time', (req, res) => {
  res.json({ serverMs: Date.now() });
});

// ── WebSocket 대시보드 + 외부 재생 신호 ─────────────────
// REST API와 같은 포트(:3000)에서 WebSocket도 함께 서비스한다. 경로 두 개를
// 같은 httpServer에 붙여야 해서(대시보드 '/', 외부 연동 '/playback-control')
// 각각을 noServer로 만들고 upgrade 이벤트에서 경로를 보고 직접 라우팅한다 -
// WebSocketServer에 path를 안 주면 그 인스턴스가 모든 경로의 upgrade를 다
// 받아버려서, 경로별로 분리하려면 이 방식이 표준이다(ws 공식 문서 패턴).
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true }); // 대시보드 - 경로 '/'
const playbackWss = new WebSocketServer({ noServer: true }); // 외부 재생 신호 - docs/LGU_WebSocket_Playback_Signal_Protocol_simple.md

httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/playback-control') {
    playbackWss.handleUpgrade(req, socket, head, (ws) => playbackWss.emit('connection', ws, req));
  } else if (pathname === '/') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  console.log(`[WS] 대시보드 연결 - 현재 접속 수: ${wss.clients.size}`);
  ws.send(buildStatusPayload());
  // 새로고침/재접속 중에도 진행 중인 영상 교체 작업 상태를 바로 보여준다.
  ws.send(JSON.stringify({ type: 'VIDEO_REPLACE_PROGRESS', ...videoReplaceState }));

  ws.on('close', () => {
    console.log(`[WS] 대시보드 연결 종료 - 현재 접속 수: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] 오류:', err.message);
  });
});

// 외부 디스플레이 컨트롤 업체 연동 - docs/LGU_WebSocket_Playback_Signal_Protocol_simple.md.
// 인증 없음(폐쇄망 전제, 문서와 동일) - PLAY_TRIGGER 수신 시 /api/play와 동일하게 재생을
// 시작하고 ACK로 startAt을 돌려준다. 그 외 타입/파싱 실패는 ERROR로 응답한다.
playbackWss.on('connection', (ws) => {
  console.log(`[WS] 재생 신호 연결 - 현재 접속 수: ${playbackWss.clients.size}`);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: 'ERROR', message: '잘못된 JSON입니다.' }));
      return;
    }

    if (msg.type === 'PLAY_TRIGGER') {
      const startAt = triggerPlay();
      console.log(`[WS] PLAY_TRIGGER 수신 - startAt=${startAt}`);
      ws.send(JSON.stringify({ type: 'ACK', received: 'PLAY_TRIGGER', startAt }));
    } else {
      ws.send(JSON.stringify({ type: 'ERROR', message: `알 수 없는 type입니다: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] 재생 신호 연결 종료 - 현재 접속 수: ${playbackWss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] 재생 신호 오류:', err.message);
  });
});

// deviceOtaState에 보고가 없으면 'idle' - 오프라인과는 다른 의미다(이번 롤아웃 대상이
// 아니었거나 아직 자기 차례가 안 왔을 뿐, 응답이 없다는 뜻이 아니다).
function computeOtaStatus(deviceId) {
  const reported = deviceOtaState[deviceId];
  return reported ? reported.phase : 'idle';
}

function buildStatusPayload() {
  const devices = {};
  const fileStatus = {};
  const otaStatus = {};
  const versions = {};
  let online = 0;

  for (let id = 1; id <= TOTAL_DEVICES; id += 1) {
    const status = isDeviceOnline(id) ? 'online' : 'offline';
    devices[id] = status;
    if (status === 'online') online += 1;
    fileStatus[id] = computeFileStatus(id);
    otaStatus[id] = computeOtaStatus(id);
    if (typeof deviceVersion[id] === 'number') versions[id] = deviceVersion[id];
  }

  const appVersion = readAppVersion();

  const payload = {
    type: 'STATUS_UPDATE',
    online,
    total: TOTAL_DEVICES,
    devices,
    fileStatus,
    otaStatus,
    versions,
    latestVersionCode: appVersion ? appVersion.versionCode : null,
    playState: state.isPlaying ? 'playing' : 'stopped',
    currentMode: state.currentMode,
    patternConfig: state.patternConfig,
    textScrollConfig: state.textScrollConfig,
    textPatternConfig: state.textPatternConfig,
    currentColor: state.currentColor,
  };

  if (state.isPlaying) {
    payload.timecode = Math.max(0, Date.now() - state.startAt);
  }

  return JSON.stringify(payload);
}

// 1초마다 모든 대시보드 클라이언트에 현재 상태를 브로드캐스트한다.
setInterval(() => {
  if (wss.clients.size === 0) return;

  const message = buildStatusPayload();
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}, STATUS_BROADCAST_MS);

// 배포 파이프라인(deploy.py 등)이 상대경로 -o를 실행 위치에 따라 엉뚱한 곳에
// 풀어버려서 서버가 못 찾는 사고가 실제로 있었다 - 서버가 실제로 보는 절대경로를
// 시작 시 한 번 찍어서, distribute/apk 위치가 기대와 다르면 바로 눈에 띄게 한다.
console.log(`[HTTP] DISTRIBUTE_DIR = ${DISTRIBUTE_DIR}`);
console.log(`[HTTP] APK_DIR = ${APK_DIR}`);

httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP] 서버 시작 - http://localhost:${HTTP_PORT}`);
});
