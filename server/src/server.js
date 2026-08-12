// MediaSphere 마스터 서버
// Phase 1: UDP 멀티캐스트 타임코드 브로드캐스트 + REST 제어 API
// Phase 2: MQTT(wall/control)로 PLAY/STOP/LOAD/CHECK_UPDATE 제어 명령 발행
//          + WebSocket 대시보드 (기기 온라인 현황/재생 상태 브로드캐스트)

const path = require('path');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');
const express = require('express');
const mqtt = require('mqtt');
const { WebSocketServer, WebSocket } = require('ws');
const { stressToColor } = require('../lib/stressColor');

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
const TOTAL_DEVICES = 499; // 구체 배치 위도별 합산(25+40+50*7+40+25+15+4) 기준. 이전엔 500으로 잘못돼 있었음
const OFFLINE_TIMEOUT_MS = 10000; // 10초 이상 heartbeat 없으면 offline 처리
const STATUS_BROADCAST_MS = 1000;
const PATTERN_CONFIG_PATH = path.join(__dirname, '..', 'data', 'pattern-config.json');
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_COLOR_DURATION_MS = 3000;
const DEFAULT_COLOR_LEAD_TIME_MS = 2000;

// ── 파일 배포(manifest/config/영상) 경로 ──────────────────
// pipeline/slicer의 gen_manifest.py, gen_configs.py가 이 구조로 결과물을 채워 넣는 것을 전제로 한다:
//   server/distribute/videos/*.mp4   (slice_video.py -o를 여기로 지정)
//   server/distribute/manifest.json  (gen_manifest.py -o)
//   server/distribute/configs/*.json (gen_configs.py -o)
const DISTRIBUTE_DIR = path.join(__dirname, '..', 'distribute');
const MANIFEST_PATH = path.join(DISTRIBUTE_DIR, 'manifest.json');
const CONFIGS_DIR = path.join(DISTRIBUTE_DIR, 'configs');
const VIDEOS_DIR = path.join(DISTRIBUTE_DIR, 'videos');

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
  // currentMode: "video" | "pattern" - 영상 모드/패턴 모드는 상호 배타적이다.
  currentMode: 'video',
  patternConfig: {
    color: '#FFFFFF',
    interval: 500,
    duration: 3000,
    stepDelay: 200,
  },
  // 키오스크 스트레스 컬러 오버레이의 현재 상태. null이면 오버레이 없음(초기화된 상태).
  currentColor: {
    color: null,
    stress: null,
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

// ── 기기 온라인 상태 ──────────────────────────────────
// deviceId(문자열) -> 마지막 heartbeat 수신 시각(epoch ms)
const deviceLastSeen = {};

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
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] 브로커 재연결 시도 중...');
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] 오류:', err.message);
});

// wall/status/{id} heartbeat 수신 - 페이로드 내용과 무관하게 메시지가 온 것 자체를
// 해당 deviceId의 heartbeat로 취급한다.
mqttClient.on('message', (topic, payload) => {
  const statusMatch = topic.match(/^wall\/status\/(\d+)$/);
  if (statusMatch) {
    deviceLastSeen[statusMatch[1]] = Date.now();
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

// ── REST API + 대시보드 정적 파일 ─────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// 폰이 다운로드하는 영상 파일 - gen_manifest.py/gen_configs.py가 채워 넣는 distribute/videos/
app.use('/clips', express.static(VIDEOS_DIR));

// 재생 시작: isPlaying = true, startAt = 현재 시각. MQTT로 PLAY 명령도 함께 발행한다.
app.post('/api/play', (req, res) => {
  state.isPlaying = true;
  state.startAt = Date.now();
  tickCount = 0;

  publishControl({ type: 'PLAY', startAt: state.startAt });

  console.log(`[HTTP] 재생 시작 - startAt=${state.startAt}`);
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

// 모드 전환: "video" | "pattern". MQTT로 MODE_VIDEO/MODE_PATTERN을 retain 발행한다.
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (mode !== 'video' && mode !== 'pattern') {
    res.status(400).json({ success: false, error: 'mode는 "video" 또는 "pattern"이어야 합니다.' });
    return;
  }

  state.currentMode = mode;
  publishControl({ type: mode === 'video' ? 'MODE_VIDEO' : 'MODE_PATTERN' });

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

// 현재 상태 조회
app.get('/api/state', (req, res) => {
  const elapsedMs = state.isPlaying ? Math.max(0, Date.now() - state.startAt) : state.stoppedElapsedMs;

  res.json({ ...state, elapsedMs });
});

// 서버-폰 시간 오프셋 측정용 - 폰의 TimeSyncManager가 RTT 계산에 사용한다
app.get('/api/time', (req, res) => {
  res.json({ serverMs: Date.now() });
});

// ── WebSocket 대시보드 ────────────────────────────────
// REST API와 같은 포트(:3000)에서 WebSocket도 함께 서비스한다.
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log(`[WS] 대시보드 연결 - 현재 접속 수: ${wss.clients.size}`);
  ws.send(buildStatusPayload());

  ws.on('close', () => {
    console.log(`[WS] 대시보드 연결 종료 - 현재 접속 수: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] 오류:', err.message);
  });
});

function buildStatusPayload() {
  const devices = {};
  const fileStatus = {};
  let online = 0;

  for (let id = 1; id <= TOTAL_DEVICES; id += 1) {
    const status = isDeviceOnline(id) ? 'online' : 'offline';
    devices[id] = status;
    if (status === 'online') online += 1;
    fileStatus[id] = computeFileStatus(id);
  }

  const payload = {
    type: 'STATUS_UPDATE',
    online,
    total: TOTAL_DEVICES,
    devices,
    fileStatus,
    playState: state.isPlaying ? 'playing' : 'stopped',
    currentMode: state.currentMode,
    patternConfig: state.patternConfig,
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

httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP] 서버 시작 - http://localhost:${HTTP_PORT}`);
});
