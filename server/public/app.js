const RECONNECT_DELAY_MS = 3000;

const onlineCountEl = document.getElementById('online-count');
const playStateEl = document.getElementById('play-state');
const timecodeEl = document.getElementById('timecode');
const gridEl = document.getElementById('device-grid');
const offlineListEl = document.getElementById('offline-list');
const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');

const modeVideoBtn = document.getElementById('mode-video');
const modePatternBtn = document.getElementById('mode-pattern');
const videoControlsEl = document.getElementById('video-controls');
const patternControlsEl = document.getElementById('pattern-controls');
const patternColorEl = document.getElementById('pattern-color');
const patternIntervalEl = document.getElementById('pattern-interval');
const patternDurationEl = document.getElementById('pattern-duration');
const patternStepDelayEl = document.getElementById('pattern-step-delay');
const btnPatternPlay = document.getElementById('btn-pattern-play');
const btnPatternStop = document.getElementById('btn-pattern-stop');
const btnSequencePlay = document.getElementById('btn-sequence-play');
const btnSequenceStop = document.getElementById('btn-sequence-stop');

// 패턴 설정 입력 중에는 STATUS_UPDATE로 값이 덮어써지지 않도록 막는다.
let editingPatternConfig = false;

// 셀 DOM은 최초 STATUS_UPDATE 수신 시 한 번만 생성하고, 이후에는 상태가 바뀐 셀만 갱신한다.
let cellRefs = null;
let lastDevices = {};

function ensureGrid(deviceIds) {
  if (cellRefs) return;

  cellRefs = {};
  deviceIds.forEach((id) => {
    const cell = document.createElement('div');
    cell.className = 'device-cell offline';
    cell.title = String(id);
    gridEl.appendChild(cell);
    cellRefs[id] = cell;
  });
}

function applyStatusUpdate(data) {
  ensureGrid(Object.keys(data.devices));

  onlineCountEl.textContent = `온라인: ${String(data.online).padStart(3, '0')} / ${data.total}`;

  if (data.playState === 'playing') {
    playStateEl.textContent = '● 재생 중';
    playStateEl.className = 'play-state playing';
    timecodeEl.textContent = formatTimecode(data.timecode);
    timecodeEl.style.display = '';
  } else {
    playStateEl.textContent = '■ 정지';
    playStateEl.className = 'play-state stopped';
    timecodeEl.textContent = '';
    timecodeEl.style.display = 'none';
  }

  const offlineIds = [];
  for (const id of Object.keys(data.devices)) {
    const status = data.devices[id];

    // 변경된 기기만 DOM을 갱신한다 (500칸 전체 리렌더 금지)
    if (lastDevices[id] !== status) {
      const cell = cellRefs[id];
      if (cell) {
        cell.classList.toggle('online', status === 'online');
        cell.classList.toggle('offline', status === 'offline');
      }
    }

    if (status === 'offline') offlineIds.push(id);
  }
  lastDevices = data.devices;

  offlineListEl.textContent = offlineIds.length > 0 ? offlineIds.join(', ') : '없음';

  if (data.currentMode) setModeUi(data.currentMode);

  if (data.patternConfig && !editingPatternConfig) {
    patternColorEl.value = data.patternConfig.color;
    patternIntervalEl.value = data.patternConfig.interval;
    patternDurationEl.value = data.patternConfig.duration;
    patternStepDelayEl.value = data.patternConfig.stepDelay;
  }
}

// 모드 토글 강조 표시 + 영상/패턴 컨트롤 활성화 상태를 함께 갱신한다.
function setModeUi(mode) {
  const isVideo = mode === 'video';

  modeVideoBtn.classList.toggle('active', isVideo);
  modePatternBtn.classList.toggle('active', !isVideo);

  btnPlay.disabled = !isVideo;
  btnStop.disabled = !isVideo;
  videoControlsEl.classList.toggle('disabled', !isVideo);

  patternColorEl.disabled = isVideo;
  patternIntervalEl.disabled = isVideo;
  patternDurationEl.disabled = isVideo;
  patternStepDelayEl.disabled = isVideo;
  btnPatternPlay.disabled = isVideo;
  btnPatternStop.disabled = isVideo;
  btnSequencePlay.disabled = isVideo;
  btnSequenceStop.disabled = isVideo;
  patternControlsEl.classList.toggle('disabled', isVideo);
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sendPatternConfig() {
  postJson('/api/pattern/config', {
    color: patternColorEl.value,
    interval: Number(patternIntervalEl.value),
    duration: Number(patternDurationEl.value),
    stepDelay: Number(patternStepDelayEl.value),
  }).catch((err) => console.error('[HTTP] 패턴 설정 저장 실패', err));
}

function formatTimecode(ms) {
  const totalMs = Math.max(0, ms || 0);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = Math.floor(totalMs % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}`);

  ws.addEventListener('open', () => {
    console.log('[WS] 연결됨');
  });

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'STATUS_UPDATE') applyStatusUpdate(data);
  });

  ws.addEventListener('close', () => {
    console.log('[WS] 연결 끊김 - 3초 후 재연결');
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

btnPlay.addEventListener('click', () => {
  fetch('/api/play', { method: 'POST' }).catch((err) => console.error('[HTTP] PLAY 요청 실패', err));
});

btnStop.addEventListener('click', () => {
  fetch('/api/stop', { method: 'POST' }).catch((err) => console.error('[HTTP] STOP 요청 실패', err));
});

modeVideoBtn.addEventListener('click', () => {
  postJson('/api/mode', { mode: 'video' }).catch((err) => console.error('[HTTP] 모드 전환 요청 실패', err));
});

modePatternBtn.addEventListener('click', () => {
  postJson('/api/mode', { mode: 'pattern' }).catch((err) => console.error('[HTTP] 모드 전환 요청 실패', err));
});

[patternColorEl, patternIntervalEl, patternDurationEl, patternStepDelayEl].forEach((el) => {
  el.addEventListener('focus', () => {
    editingPatternConfig = true;
  });
  el.addEventListener('blur', () => {
    editingPatternConfig = false;
  });
  el.addEventListener('change', sendPatternConfig);
});

btnPatternPlay.addEventListener('click', () => {
  fetch('/api/pattern/start', { method: 'POST' }).catch((err) => console.error('[HTTP] 패턴 시작 요청 실패', err));
});

btnPatternStop.addEventListener('click', () => {
  fetch('/api/pattern/stop', { method: 'POST' }).catch((err) => console.error('[HTTP] 패턴 정지 요청 실패', err));
});

btnSequencePlay.addEventListener('click', () => {
  fetch('/api/sequence/start', { method: 'POST' }).catch((err) => console.error('[HTTP] 순차 점멸 시작 요청 실패', err));
});

btnSequenceStop.addEventListener('click', () => {
  fetch('/api/sequence/stop', { method: 'POST' }).catch((err) => console.error('[HTTP] 순차 점멸 정지 요청 실패', err));
});

connect();
