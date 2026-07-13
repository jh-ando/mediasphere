// MediaSphere 마스터 서버
// Phase 1: UDP 멀티캐스트 타임코드 브로드캐스트 + REST 제어 API
// Phase 2: MQTT(wall/control)로 PLAY/STOP/LOAD/CHECK_UPDATE 제어 명령 발행
//          + WebSocket 대시보드 (기기 온라인 현황/재생 상태 브로드캐스트)

const path = require('path');
const http = require('http');
const dgram = require('dgram');
const express = require('express');
const mqtt = require('mqtt');
const { WebSocketServer, WebSocket } = require('ws');

// ── 설정값 ──────────────────────────────────────────
const MULTICAST_ADDR = '239.0.0.1';
const MULTICAST_PORT = 5000;
const FPS = 30;
const TICK_MS = 1000 / FPS;
const HTTP_PORT = 3000;
const MQTT_BROKER_URL = 'mqtt://localhost:1883';
const MQTT_CONTROL_TOPIC = 'wall/control';
const MQTT_STATUS_TOPIC_FILTER = 'wall/status/+';
const TOTAL_DEVICES = 500;
const OFFLINE_TIMEOUT_MS = 10000; // 10초 이상 heartbeat 없으면 offline 처리
const STATUS_BROADCAST_MS = 1000;

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
};

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

// wall/control에 제어 명령을 발행한다. retain: true로 발행해서
// 늦게 접속하거나 재연결한 폰도 마지막 상태(PLAY/STOP)를 즉시 받을 수 있게 한다.
function publishControl(payload) {
  const message = JSON.stringify(payload);
  mqttClient.publish(MQTT_CONTROL_TOPIC, message, { retain: true, qos: 1 }, (err) => {
    if (err) {
      console.error('[MQTT] 발행 오류:', err.message);
    } else {
      console.log(`[MQTT] ${MQTT_CONTROL_TOPIC} 발행 - ${message}`);
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
