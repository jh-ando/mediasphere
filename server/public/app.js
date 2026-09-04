const RECONNECT_DELAY_MS = 3000;
const LOW_BATTERY_PCT = 20; // 충전 중인데도 이 아래면 "낮음"으로 표시 (미충전은 별도 버킷)

const onlineCountEl = document.getElementById('online-count');
const fileStatusCountEl = document.getElementById('file-status-count');
const batteryStatusCountEl = document.getElementById('battery-status-count');
const otaStatusCountEl = document.getElementById('ota-status-count');
const versionStatusCountEl = document.getElementById('version-status-count');
const btnVersionToggle = document.getElementById('btn-version-toggle');
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
const btnIdle = document.getElementById('btn-idle');
const videoControlsEl = document.getElementById('video-controls');
const patternControlsEl = document.getElementById('pattern-controls');
const patternColorEl = document.getElementById('pattern-color');
const patternColorModeEl = document.getElementById('pattern-color-mode');
const patternColorSaturationEl = document.getElementById('pattern-color-saturation');
const patternIntervalEl = document.getElementById('pattern-interval');
const patternDurationEl = document.getElementById('pattern-duration');
const patternStepDelayEl = document.getElementById('pattern-step-delay');
const btnPatternPlay = document.getElementById('btn-pattern-play');
const btnPatternStop = document.getElementById('btn-pattern-stop');
const btnSequencePlay = document.getElementById('btn-sequence-play');
const btnSequenceStop = document.getElementById('btn-sequence-stop');
const playlistCuesEl = document.getElementById('playlist-cues');
const btnPlaylistAddCue = document.getElementById('btn-playlist-add-cue');
const btnPlaylistSave = document.getElementById('btn-playlist-save');
const btnPlaylistPlay = document.getElementById('btn-playlist-play');
const btnPlaylistStop = document.getElementById('btn-playlist-stop');
const playlistStatusEl = document.getElementById('playlist-status');

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

const vrFileEl = document.getElementById('vr-file');
const btnVrStart = document.getElementById('btn-vr-start');
const btnVrCancel = document.getElementById('btn-vr-cancel');
const vrStatusEl = document.getElementById('vr-status');
const vrLogEl = document.getElementById('vr-log');

// 패턴/텍스트 설정 입력 중에는 STATUS_UPDATE로 값이 덮어써지지 않도록 막는다.
let editingPatternConfig = false;
let editingTextConfig = false;

// 버전 확인/ID 표시 토글 상태 - 서버에 별도로 물어보지 않고 이 페이지에서만 기억한다
// (새로고침하면 꺼진 상태로 초기화됨 - 폰 쪽 상태와 항상 일치시키려면 서버가 상태를
// 들고 있어야 하는데, 이 두 토글은 그 정도로 중요하지 않다고 판단해 단순하게 둠).
let versionCheckEnabled = false;
let idShowing = false;

// 재생목록 - 큐 배열은 이 페이지에서 편집하다가 "저장" 눌러야 서버에 반영된다(자동저장 아님).
// 재생 중에는 서버가 편집을 거부하므로, 여기서도 재생 중엔 입력을 막아 혼란을 방지한다.
let playlistCues = [];
let playlistPlaying = false;
let playlistCurrentCueIndex = -1;

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
  const otaStatus = data.otaStatus || {};
  const otaCounts = { idle: 0, downloading: 0, installing: 0, done: 0, failed: 0 };
  const versions = data.versions || {};
  const latestVersionCode = data.latestVersionCode;
  const versionCounts = { latest: 0, old: 0, unknown: 0 };
  const battery = data.battery || {};
  const batteryCounts = { ok: 0, low: 0, notCharging: 0, unknown: 0 };

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

    const oStatus = otaStatus[id] || 'idle';
    otaCounts[oStatus] = (otaCounts[oStatus] || 0) + 1;

    // 버전 카운트/셀 표시는 latestVersionCode를 알 때만 의미가 있다(app-version.json 없으면
    // 비교 기준이 없어 전부 unknown 취급). 토글이 꺼져 있어도 카운트 텍스트는 항상 계산해서
    // 보여준다 - 셀 강조만 토글로 켜고 끈다.
    const v = versions[id];
    const vKey = typeof v !== 'number' || typeof latestVersionCode !== 'number'
      ? 'unknown'
      : (v >= latestVersionCode ? 'latest' : 'old');
    versionCounts[vKey] += 1;
    if (cell) cell.classList.toggle('version-mismatch', versionCheckEnabled && vKey === 'old');

    // 439대 상시 USB 전원 설치라 배터리 %보다 "충전 중인지"가 더 급한 신호다 - 케이블이
    // 헐거워지면 완전 방전으로 꺼지기 몇 시간 전부터 미리 알 수 있다.
    const b = battery[id];
    const batteryKey = !b ? 'unknown' : !b.charging ? 'notCharging' : b.pct < LOW_BATTERY_PCT ? 'low' : 'ok';
    batteryCounts[batteryKey] += 1;
    if (cell) {
      cell.classList.toggle('battery-not-charging', batteryKey === 'notCharging');
      cell.classList.toggle('battery-low', batteryKey === 'low');
      cell.title = b ? `#${id} - 배터리 ${b.pct}% (${b.charging ? '충전 중' : '미충전'})` : `#${id}`;
    }

    if (status === 'offline') offlineIds.push(id);
  }
  lastDevices = data.devices;

  fileStatusCountEl.textContent =
    `파일: 정상 ${fileCounts.ok} / 불일치 ${fileCounts.mismatch} / 무응답 ${fileCounts.unknown}`;

  batteryStatusCountEl.textContent =
    `배터리: 정상 ${batteryCounts.ok} / 낮음 ${batteryCounts.low} `
    + `/ 미충전 ${batteryCounts.notCharging} / 확인불가 ${batteryCounts.unknown}`;

  otaStatusCountEl.textContent =
    `OTA: 대기 ${otaCounts.idle} / 다운 ${otaCounts.downloading} / 설치 ${otaCounts.installing} `
    + `/ 완료 ${otaCounts.done} / 실패 ${otaCounts.failed}`;

  versionStatusCountEl.textContent = typeof latestVersionCode !== 'number'
    ? '버전: app-version.json 없음'
    : `버전(최신 v${latestVersionCode}): 최신 ${versionCounts.latest} / 구버전 ${versionCounts.old} `
      + `/ 확인불가 ${versionCounts.unknown}`;

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

  if (data.currentMode) setModeUi(data.currentMode);

  if (data.patternConfig && !editingPatternConfig) {
    patternColorEl.value = data.patternConfig.color;
    patternIntervalEl.value = data.patternConfig.interval;
    patternDurationEl.value = data.patternConfig.duration;
    patternStepDelayEl.value = data.patternConfig.stepDelay;
    patternColorModeEl.value = data.patternConfig.colorMode || 'fixed';
    patternColorSaturationEl.value = data.patternConfig.colorSaturation ?? 100;
    applyPatternColorModeUi(patternColorModeEl.value);
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

// 모드 토글 강조 표시 + 그 모드에 쓰는 컨트롤 그룹만 보여준다(나머지는 hidden으로
// 화면에서 아예 빠짐 - 예전엔 전부 항상 그려두고 흐리게(disabled)만 했었음).
function setModeUi(mode) {
  const isVideo = mode === 'video';
  const isPattern = mode === 'pattern';
  const isText = mode === 'text';

  modeVideoBtn.classList.toggle('active', isVideo);
  modePatternBtn.classList.toggle('active', isPattern);
  modeTextBtn.classList.toggle('active', isText);

  videoControlsEl.hidden = !isVideo;
  patternControlsEl.hidden = !isPattern;
  textControlsEl.hidden = !isText;
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
    colorMode: patternColorModeEl.value,
    colorSaturation: Number(patternColorSaturationEl.value),
  }).catch((err) => console.error('[HTTP] 패턴 설정 저장 실패', err));
}

// 색상 모드에 따라 색상 피커/채도 입력을 켜고 끈다 - "고정"이 아니면 색상 피커는 무의미하고,
// "랜덤(컬러)"가 아니면 채도도 무의미하다(랜덤(흑백)은 채도가 항상 0으로 고정된 개념).
function applyPatternColorModeUi(mode) {
  patternColorEl.disabled = mode !== 'fixed';
  patternColorSaturationEl.disabled = mode !== 'random';
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
    if (data.type === 'VIDEO_REPLACE_PROGRESS') applyVideoReplaceProgress(data);
    if (data.type === 'PATTERN_PLAYLIST_PROGRESS') applyPlaylistProgress(data);
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

// 절전 모드는 별도 상태가 아니라 패턴 모드로 전환하는 편의 버튼이라, 눌러도 이 버튼
// 자체는 활성 표시를 갖지 않는다 - STATUS_UPDATE가 오면 패턴 모드 탭이 활성화되어 보인다.
btnIdle.addEventListener('click', () => {
  fetch('/api/idle', { method: 'POST' }).catch((err) => console.error('[HTTP] 절전 모드 요청 실패', err));
});

[
  patternColorEl, patternIntervalEl, patternDurationEl, patternStepDelayEl,
  patternColorModeEl, patternColorSaturationEl,
].forEach((el) => {
  el.addEventListener('focus', () => {
    editingPatternConfig = true;
  });
  el.addEventListener('blur', () => {
    editingPatternConfig = false;
  });
  el.addEventListener('change', sendPatternConfig);
});

patternColorModeEl.addEventListener('change', () => {
  applyPatternColorModeUi(patternColorModeEl.value);
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

// duration:0 = 자동으로 안 꺼지고 계속 표시(PATTERN_START의 duration=0과 같은 관례) -
// 끌 때는 /api/hide-id로 명시적으로 끈다. 상태는 이 버튼 라벨로만 표시한다.
btnShowId.addEventListener('click', () => {
  const turningOn = !idShowing;
  const url = turningOn ? '/api/show-id' : '/api/hide-id';
  const body = turningOn ? { duration: 0 } : undefined;
  fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
    .then(() => {
      idShowing = turningOn;
      btnShowId.textContent = idShowing ? 'ID 끄기' : 'ID 표시';
      btnShowId.classList.toggle('active', idShowing);
    })
    .catch((err) => console.error('[HTTP] ID 표시 토글 요청 실패', err));
});

btnVersionToggle.addEventListener('click', () => {
  versionCheckEnabled = !versionCheckEnabled;
  btnVersionToggle.textContent = versionCheckEnabled ? '버전 확인 끄기' : '버전 확인 켜기';
  btnVersionToggle.classList.toggle('active', versionCheckEnabled);
  // 다음 STATUS_UPDATE(최대 1초 내)가 오면 셀 강조가 자동으로 반영된다.
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

// ── 영상 교체 ──────────────────────────────────────────
const VR_STEP_LABEL = {
  idle: '대기 중',
  tiles: '타일 좌표 생성 중...',
  encoding: '인코딩 중... (439대 기준 수십 분 걸릴 수 있음)',
  publish: '배포 발행 중...',
  done: '완료 - 폰에 발행됨',
  error: '실패',
};

// VIDEO_REPLACE_PROGRESS 메시지가 올 때마다(로그 한 줄 늘 때마다 포함) 그대로 다시 그린다 -
// 로그가 최대 300줄로 서버에서 이미 잘려있어 매번 통째로 다시 그려도 부담 없다.
function applyVideoReplaceProgress(data) {
  const step = data.step || 'idle';
  vrStatusEl.textContent = VR_STEP_LABEL[step] || step;
  vrStatusEl.className = `video-replace-status step-${step}`;
  if (data.error) vrStatusEl.textContent += ` - ${data.error}`;

  vrLogEl.textContent = (data.log || []).join('\n');
  vrLogEl.scrollTop = vrLogEl.scrollHeight;

  const busy = step !== 'idle' && step !== 'done' && step !== 'error';
  btnVrStart.disabled = busy;
  btnVrCancel.disabled = !busy;
}

btnVrStart.addEventListener('click', () => {
  const file = vrFileEl.files[0];
  if (!file) {
    window.alert('영상 파일을 선택하세요.');
    return;
  }
  const mode = document.querySelector('input[name="vr-mode"]:checked').value;
  const modeLabel = mode === 'frontback' ? '일반(1:1) 전/후면' : '등장방형';
  if (!window.confirm(`${modeLabel} 모드로 "${file.name}"을(를) 439대 전체에 배포할까요? `
    + '인코딩에 수십 분이 걸릴 수 있습니다.')) return;

  const formData = new FormData();
  formData.append('mode', mode);
  formData.append('video', file);

  btnVrStart.disabled = true;
  vrStatusEl.textContent = '업로드 중...';
  vrStatusEl.className = 'video-replace-status step-tiles';

  fetch('/api/video/replace', { method: 'POST', body: formData })
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) {
        window.alert(`시작 실패: ${data.error}`);
        btnVrStart.disabled = false;
      }
      // 성공하면 이후 진행상황은 VIDEO_REPLACE_PROGRESS WebSocket 메시지로 갱신된다.
    })
    .catch((err) => {
      console.error('[HTTP] 영상 교체 요청 실패', err);
      btnVrStart.disabled = false;
    });
});

btnVrCancel.addEventListener('click', () => {
  if (!window.confirm('진행 중인 영상 교체를 취소할까요? 지금까지 인코딩한 내용은 버려집니다.')) return;

  fetch('/api/video/replace/cancel', { method: 'POST' })
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) window.alert(`취소 실패: ${data.error || '알 수 없는 오류'}`);
      // 실제 상태 전환은 VIDEO_REPLACE_PROGRESS로 반영된다.
    })
    .catch((err) => console.error('[HTTP] 영상 교체 취소 요청 실패', err));
});

// ── 패턴 재생목록 ──────────────────────────────────────
// 큐 배열은 이 페이지가 들고 있다가 "저장" 버튼을 눌러야만 서버에 반영된다(입력마다
// 자동저장 안 함) - 재생목록 편집은 색상/주기 등 즉시발행 필드들과 성격이 달라서
// (여러 값을 한꺼번에 맞추고 나서 저장하는 게 자연스러움) 별도 흐름으로 뒀다.
function createCueRow(cue, index) {
  const row = document.createElement('div');
  row.className = 'playlist-cue-row';
  row.dataset.index = String(index);

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = cue.color;
  colorInput.disabled = cue.colorMode !== undefined && cue.colorMode !== 'fixed';
  colorInput.addEventListener('input', () => { playlistCues[index].color = colorInput.value; });

  const colorModeSelect = document.createElement('select');
  colorModeSelect.innerHTML =
    '<option value="fixed">고정</option>'
    + '<option value="random">랜덤(컬러)</option>'
    + '<option value="randomGray">랜덤(흑백)</option>';
  colorModeSelect.value = cue.colorMode || 'fixed';
  colorModeSelect.addEventListener('change', () => {
    playlistCues[index].colorMode = colorModeSelect.value;
    colorInput.disabled = colorModeSelect.value !== 'fixed';
    saturationInput.disabled = colorModeSelect.value !== 'random';
  });

  const saturationInput = document.createElement('input');
  saturationInput.type = 'number';
  saturationInput.min = '0';
  saturationInput.max = '100';
  saturationInput.step = '5';
  saturationInput.title = '채도(%) - 랜덤(컬러)일 때만 적용';
  saturationInput.value = cue.colorSaturation ?? 100;
  saturationInput.disabled = colorModeSelect.value !== 'random';
  saturationInput.addEventListener('change', () => {
    playlistCues[index].colorSaturation = Number(saturationInput.value);
  });

  const intervalInput = document.createElement('input');
  intervalInput.type = 'number';
  intervalInput.min = '50';
  intervalInput.step = '50';
  intervalInput.title = '주기(ms)';
  intervalInput.value = cue.interval;
  intervalInput.addEventListener('change', () => { playlistCues[index].interval = Number(intervalInput.value); });

  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.min = '500';
  durationInput.step = '500';
  durationInput.title = '지속시간(ms) - 순차 점멸은 폰 한 대가 아니라 이 큐 전체가 지속되는 총 시간';
  durationInput.value = cue.duration;
  durationInput.addEventListener('change', () => { playlistCues[index].duration = Number(durationInput.value); });

  const stepDelayInput = document.createElement('input');
  stepDelayInput.type = 'number';
  stepDelayInput.min = '0';
  stepDelayInput.step = '50';
  stepDelayInput.title = '폰 간 딜레이(ms) - 순차 점멸에만 쓰임';
  stepDelayInput.value = cue.stepDelay;
  stepDelayInput.addEventListener('change', () => { playlistCues[index].stepDelay = Number(stepDelayInput.value); });

  const modeSelect = document.createElement('select');
  modeSelect.innerHTML = '<option value="all">전체 점멸</option><option value="sequence">순차 점멸</option>';
  modeSelect.value = cue.mode;
  modeSelect.addEventListener('change', () => { playlistCues[index].mode = modeSelect.value; });

  const moveUpBtn = document.createElement('button');
  moveUpBtn.className = 'btn-small';
  moveUpBtn.textContent = '↑';
  moveUpBtn.title = '위로 이동';
  moveUpBtn.disabled = index === 0;
  moveUpBtn.addEventListener('click', () => {
    [playlistCues[index - 1], playlistCues[index]] = [playlistCues[index], playlistCues[index - 1]];
    renderPlaylistCues();
  });

  const moveDownBtn = document.createElement('button');
  moveDownBtn.className = 'btn-small';
  moveDownBtn.textContent = '↓';
  moveDownBtn.title = '아래로 이동';
  moveDownBtn.disabled = index === playlistCues.length - 1;
  moveDownBtn.addEventListener('click', () => {
    [playlistCues[index], playlistCues[index + 1]] = [playlistCues[index + 1], playlistCues[index]];
    renderPlaylistCues();
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-small btn-danger';
  deleteBtn.textContent = '삭제';
  deleteBtn.addEventListener('click', () => {
    playlistCues.splice(index, 1);
    renderPlaylistCues();
  });

  const label = document.createElement('span');
  label.textContent = `#${index + 1}`;

  row.append(
    label, colorInput, colorModeSelect, saturationInput, intervalInput, durationInput, stepDelayInput, modeSelect,
    moveUpBtn, moveDownBtn, deleteBtn,
  );
  return row;
}

function renderPlaylistCues() {
  playlistCuesEl.innerHTML = '';
  if (playlistCues.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'playlist-cue-row';
    empty.textContent = '큐가 없습니다 - "+ 큐 추가"로 만들어보세요.';
    playlistCuesEl.appendChild(empty);
  } else {
    playlistCues.forEach((cue, index) => {
      const row = createCueRow(cue, index);
      if (playlistPlaying && index === playlistCurrentCueIndex) row.classList.add('active');
      playlistCuesEl.appendChild(row);
    });
  }
  updatePlaylistEditability();
}

// 재생 중엔 모든 편집 요소(입력/추가/삭제/저장/이동)를 막는다 - 서버도 같은 규칙을
// /api/pattern/playlist(저장)에서 강제하지만, 여기서도 막아야 헷갈리지 않는다.
// 재생 중이 아닐 땐 일부러 강제로 활성화하지 않는다 - ↑/↓ 이동 버튼은 맨 위/아래 큐에서
// createCueRow()가 이미 disabled를 걸어두는데, 여기서 무조건 false로 덮어쓰면 그 경계
// 처리가 매번 renderPlaylistCues() 직후 풀려버린다.
function updatePlaylistEditability() {
  const disabled = playlistPlaying;
  if (disabled) {
    playlistCuesEl.querySelectorAll('input, select, button').forEach((el) => { el.disabled = true; });
  }
  btnPlaylistAddCue.disabled = disabled;
  btnPlaylistSave.disabled = disabled;
  btnPlaylistPlay.disabled = disabled || playlistCues.length === 0;
  btnPlaylistStop.disabled = !disabled;
}

function applyPlaylistProgress(data) {
  playlistPlaying = Boolean(data.playing);
  playlistCurrentCueIndex = typeof data.currentCueIndex === 'number' ? data.currentCueIndex : -1;

  playlistStatusEl.textContent = playlistPlaying
    ? `재생 중 (큐 ${playlistCurrentCueIndex + 1}/${playlistCues.length})`
    : '재생 안 함';
  playlistStatusEl.className = playlistPlaying ? 'video-replace-status step-encoding' : 'video-replace-status';

  playlistCuesEl.querySelectorAll('.playlist-cue-row').forEach((row) => {
    row.classList.toggle('active', playlistPlaying && Number(row.dataset.index) === playlistCurrentCueIndex);
  });
  updatePlaylistEditability();
}

btnPlaylistAddCue.addEventListener('click', () => {
  playlistCues.push({
    color: '#ffffff', colorMode: 'fixed', colorSaturation: 100,
    interval: 500, duration: 3000, stepDelay: 200, mode: 'all',
  });
  renderPlaylistCues();
});

btnPlaylistSave.addEventListener('click', () => {
  postJson('/api/pattern/playlist', { cues: playlistCues })
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) window.alert(`저장 실패: ${data.error}`);
    })
    .catch((err) => console.error('[HTTP] 재생목록 저장 실패', err));
});

btnPlaylistPlay.addEventListener('click', () => {
  fetch('/api/pattern/playlist/play', { method: 'POST' })
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) window.alert(`재생 실패: ${data.error}`);
    })
    .catch((err) => console.error('[HTTP] 재생목록 재생 요청 실패', err));
});

btnPlaylistStop.addEventListener('click', () => {
  fetch('/api/pattern/playlist/stop', { method: 'POST' })
    .catch((err) => console.error('[HTTP] 재생목록 정지 요청 실패', err));
});

// 페이지 로드 시 저장된 재생목록/재생상태를 불러온다.
fetch('/api/pattern/playlist')
  .then((res) => res.json())
  .then((data) => {
    if (!data.ok) return;
    playlistCues = data.patternPlaylist.cues || [];
    playlistPlaying = Boolean(data.playlistState && data.playlistState.playing);
    playlistCurrentCueIndex = data.playlistState ? data.playlistState.currentCueIndex : -1;
    renderPlaylistCues();
  })
  .catch((err) => console.error('[HTTP] 재생목록 조회 실패', err));

connect();
