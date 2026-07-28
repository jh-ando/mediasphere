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
const TOTAL_DEVICES = 499; // 구체 배치 위도별 합산(25+40+50*7+40+25+15+4) 기준. 이전엔 500으로 잘못돼 있었음
const OFFLINE_TIMEOUT_MS = 10000; // 10초 이상 heartbeat 없으면 offline 처리
const STATUS_BROADCAST_MS = 1000;
const PATTERN_CONFIG_PATH = path.join(__dirname, '..', 'data', 'pattern-config.json');
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_COLOR_DURATION_MS = 3000;
const DEFAULT_COLOR_LEAD_TIME_MS = 2000;

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
  const match = topic.match(/^wall\/status\/(\d+)$/);
  if (!match) return;

  const deviceId = match[1];
  deviceLastSeen[deviceId] = Date.now();
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
  state.currentColor = { color: null, stress: null };

  publishControl({ type: 'COLOR_CLEAR', startAt: Date.now() + 500 }, { retain: false });
  publishColorState();

  console.log('[HTTP] 컬러 오버레이 초기화');
  res.json({ ok: true });
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
  let online = 0;

  for (let id = 1; id <= TOTAL_DEVICES; id += 1) {
    const status = isDeviceOnline(id) ? 'online' : 'offline';
    devices[id] = status;
    if (status === 'online') online += 1;
  }

  const payload = {
    type: 'STATUS_UPDATE',
    online,
    total: TOTAL_DEVICES,
    devices,
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
