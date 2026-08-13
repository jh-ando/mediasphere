const RECONNECT_DELAY_MS = 3000;

const onlineCountEl = document.getElementById('online-count');
const fileStatusCountEl = document.getElementById('file-status-count');
const btnShowId = document.getElementById('btn-show-id');
const playStateEl = document.getElementById('play-state');
const timecodeEl = document.getElementById('timecode');
const gridEl = document.getElementById('device-grid');
const offlineListEl = document.getElementById('offline-list');
const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');

const modeVideoBtn = document.getElementById('mode-video');
const modePatternBtn = document.getElementById('mode-pattern');
const modeTextBtn = document.getElementById('mode-text');
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
const colorSwatchEl = document.getElementById('color-swatch');
const colorLabelEl = document.getElementById('color-label');
const btnColorReset = document.getElementById('btn-color-reset');

const textControlsEl = document.getElementById('text-controls');
const textContentEl = document.getElementById('text-content');
const textFontEl = document.getElementById('text-font');
const textFontSizeEl = document.getElementById('text-font-size');
const textColorEl = document.getElementById('text-color');
const textBgColorEl = document.getElementById('text-bg-color');
const textAlignEl = document.getElementById('text-align');
const textDirectionEl = document.getElementById('text-direction');
const textSpeedEl = document.getElementById('text-speed');
const btnTextStart = document.getElementById('btn-text-start');
const btnTextStop = document.getElementById('btn-text-stop');

const restartDeviceIdsEl = document.getElementById('restart-device-ids');
const btnRestartSelected = document.getElementById('btn-restart-selected');
const btnRestartAll = document.getElementById('btn-restart-all');

// 패턴/텍스트 설정 입력 중에는 STATUS_UPDATE로 값이 덮어써지지 않도록 막는다.
let editingPatternConfig = false;
let editingTextConfig = false;

// 셀 DOM은 최초 STATUS_UPDATE 수신 시 한 번만 생성하고, 이후에는 상태가 바뀐 셀만 갱신한다.
let cellRefs = null;
let lastDevices = {};
let lastColor = null;

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

  const currentColorHex = data.currentColor && data.currentColor.color;

  const offlineIds = [];
  const fileStatus = data.fileStatus || {};
  const fileCounts = { ok: 0, mismatch: 0, unknown: 0 };

  for (const id of Object.keys(data.devices)) {
    const status = data.devices[id];

    // 변경된 기기만 DOM을 갱신한다 (500칸 전체 리렌더 금지)
    if (lastDevices[id] !== status) {
      const cell = cellRefs[id];
      if (cell) {
        cell.classList.toggle('online', status === 'online');
        cell.classList.toggle('offline', status === 'offline');
        cell.style.backgroundColor = status === 'online' && currentColorHex ? currentColorHex : '';
      }
    }

    const fStatus = fileStatus[id] || 'unknown';
    fileCounts[fStatus] = (fileCounts[fStatus] || 0) + 1;
    const cell = cellRefs[id];
    if (cell) cell.classList.toggle('mismatch', fStatus === 'mismatch');

    if (status === 'offline') offlineIds.push(id);
  }
  lastDevices = data.devices;

  fileStatusCountEl.textContent =
    `파일: 정상 ${fileCounts.ok} / 불일치 ${fileCounts.mismatch} / 무응답 ${fileCounts.unknown}`;

  offlineListEl.textContent = offlineIds.length > 0 ? offlineIds.join(', ') : '없음';

  // 컬러 자체가 바뀐 경우엔 상태가 그대로인 online 셀들도 다시 칠해야 한다.
  if (currentColorHex !== lastColor) {
    Object.keys(data.devices).forEach((id) => {
      if (data.devices[id] !== 'online') return;
      const cell = cellRefs[id];
      if (cell) cell.style.backgroundColor = currentColorHex || '';
    });
    lastColor = currentColorHex;
  }

  colorSwatchEl.style.backgroundColor = currentColorHex || '';
  colorLabelEl.textContent = currentColorHex ? `컬러: ${currentColorHex}` : '컬러: 없음';

  if (data.currentMode) setModeUi(data.currentMode);

  if (data.patternConfig && !editingPatternConfig) {
    patternColorEl.value = data.patternConfig.color;
    patternIntervalEl.value = data.patternConfig.interval;
    patternDurationEl.value = data.patternConfig.duration;
    patternStepDelayEl.value = data.patternConfig.stepDelay;
  }

  if (data.textScrollConfig && !editingTextConfig) {
    textContentEl.value = data.textScrollConfig.text;
    textFontEl.value = data.textScrollConfig.font;
    textFontSizeEl.value = data.textScrollConfig.fontSize;
    textColorEl.value = data.textScrollConfig.color;
    textBgColorEl.value = data.textScrollConfig.bgColor;
    textAlignEl.value = data.textScrollConfig.align;
    textDirectionEl.value = data.textScrollConfig.direction;
    textSpeedEl.value = data.textScrollConfig.speed;
  }
}

// 모드 토글 강조 표시 + 영상/패턴/텍스트 컨트롤 활성화 상태를 함께 갱신한다.
function setModeUi(mode) {
  const isVideo = mode === 'video';
  const isPattern = mode === 'pattern';
  const isText = mode === 'text';

  modeVideoBtn.classList.toggle('active', isVideo);
  modePatternBtn.classList.toggle('active', isPattern);
  modeTextBtn.classList.toggle('active', isText);

  btnPlay.disabled = !isVideo;
  btnStop.disabled = !isVideo;
  videoControlsEl.classList.toggle('disabled', !isVideo);

  patternColorEl.disabled = !isPattern;
  patternIntervalEl.disabled = !isPattern;
  patternDurationEl.disabled = !isPattern;
  patternStepDelayEl.disabled = !isPattern;
  btnPatternPlay.disabled = !isPattern;
  btnPatternStop.disabled = !isPattern;
  btnSequencePlay.disabled = !isPattern;
  btnSequenceStop.disabled = !isPattern;
  patternControlsEl.classList.toggle('disabled', !isPattern);

  [textContentEl, textFontEl, textFontSizeEl, textColorEl, textBgColorEl,
    textAlignEl, textDirectionEl, textSpeedEl, btnTextStart, btnTextStop].forEach((el) => {
    el.disabled = !isText;
  });
  textControlsEl.classList.toggle('disabled', !isText);
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

function sendTextConfig() {
  postJson('/api/text/config', {
    text: textContentEl.value,
    font: textFontEl.value,
    fontSize: Number(textFontSizeEl.value),
    color: textColorEl.value,
    bgColor: textBgColorEl.value,
    align: textAlignEl.value,
    direction: textDirectionEl.value,
    speed: Number(textSpeedEl.value),
  }).catch((err) => console.error('[HTTP] 텍스트 설정 저장 실패', err));
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

modeTextBtn.addEventListener('click', () => {
  postJson('/api/mode', { mode: 'text' }).catch((err) => console.error('[HTTP] 모드 전환 요청 실패', err));
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

[textContentEl, textFontEl, textFontSizeEl, textColorEl, textBgColorEl,
  textAlignEl, textDirectionEl, textSpeedEl].forEach((el) => {
  el.addEventListener('focus', () => {
    editingTextConfig = true;
  });
  el.addEventListener('blur', () => {
    editingTextConfig = false;
  });
  el.addEventListener('change', sendTextConfig);
});

btnTextStart.addEventListener('click', () => {
  fetch('/api/text/start', { method: 'POST' }).catch((err) => console.error('[HTTP] 텍스트 시작 요청 실패', err));
});

btnTextStop.addEventListener('click', () => {
  fetch('/api/text/stop', { method: 'POST' }).catch((err) => console.error('[HTTP] 텍스트 정지 요청 실패', err));
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

btnColorReset.addEventListener('click', () => {
  fetch('/api/color-reset', { method: 'POST' }).catch((err) => console.error('[HTTP] 컬러 초기화 요청 실패', err));
});

btnShowId.addEventListener('click', () => {
  fetch('/api/show-id', { method: 'POST' }).catch((err) => console.error('[HTTP] ID 표시 요청 실패', err));
});

// 쉼표로 구분된 deviceId 문자열("1, 2,3")을 정수 배열로 파싱한다. 잘못된 값이 섞여 있으면 null.
function parseDeviceIds(text) {
  const parts = text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;

  const ids = parts.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return undefined;
  return ids;
}

btnRestartSelected.addEventListener('click', () => {
  const ids = parseDeviceIds(restartDeviceIdsEl.value);
  if (ids === undefined) {
    window.alert('deviceId는 쉼표로 구분된 양의 정수로 입력하세요 (예: 1,2,3)');
    return;
  }
  if (ids === null) {
    window.alert('재시작할 deviceId를 입력하세요 (전체는 "전체 재시작" 버튼 사용)');
    return;
  }
  if (!window.confirm(`${ids.length}대(${ids.join(', ')})를 재시작할까요?`)) return;

  postJson('/api/restart-app', { targetDeviceIds: ids })
    .catch((err) => console.error('[HTTP] 앱 재시작(선택) 요청 실패', err));
});

btnRestartAll.addEventListener('click', () => {
  if (!window.confirm('전체 기기를 재시작할까요?')) return;

  fetch('/api/restart-app', { method: 'POST' })
    .catch((err) => console.error('[HTTP] 앱 재시작(전체) 요청 실패', err));
});

connect();
