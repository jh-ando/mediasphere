const RECONNECT_DELAY_MS = 3000;

const onlineCountEl = document.getElementById('online-count');
const playStateEl = document.getElementById('play-state');
const timecodeEl = document.getElementById('timecode');
const gridEl = document.getElementById('device-grid');
const offlineListEl = document.getElementById('offline-list');
const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');

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

connect();
