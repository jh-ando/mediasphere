const RECONNECT_DELAY_MS = 3000;

const onlineCountEl = document.getElementById('online-count');
const fileStatusCountEl = document.getElementById('file-status-count');
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

const textPatternControlsEl = document.getElementById('text-pattern-controls');
const textPatternContentEl = document.getElementById('text-pattern-content');
const textPatternFgColorEl = document.getElementById('text-pattern-fg-color');
const textPatternBgColorEl = document.getElementById('text-pattern-bg-color');
const textPatternCharStaggerEl = document.getElementById('text-pattern-char-stagger');
const textPatternFadeInEl = document.getElementById('text-pattern-fade-in');
const textPatternHoldEl = document.getElementById('text-pattern-hold');
const textPatternFadeOutEl = document.getElementById('text-pattern-fade-out');
const btnTextPatternStart = document.getElementById('btn-text-pattern-start');
const btnTextPatternStop = document.getElementById('btn-text-pattern-stop');

const restartDeviceIdsEl = document.getElementById('restart-device-ids');
const btnRestartSelected = document.getElementById('btn-restart-selected');
const btnRestartAll = document.getElementById('btn-restart-all');

const vrApCountEl = document.getElementById('vr-ap-count');
const btnVrSaveApCount = document.getElementById('btn-vr-save-ap-count');
const vrFileEl = document.getElementById('vr-file');
const btnVrStart = document.getElementById('btn-vr-start');
const btnVrCancel = document.getElementById('btn-vr-cancel');
const vrStatusEl = document.getElementById('vr-status');
const vrLogEl = document.getElementById('vr-log');

// 패턴/텍스트 설정 입력 중에는 STATUS_UPDATE로 값이 덮어써지지 않도록 막는다.
let editingPatternConfig = false;
let editingTextConfig = false;
let editingTextPatternConfig = false;

// 버전 확인/ID 표시 토글 상태 - 서버에 별도로 물어보지 않고 이 페이지에서만 기억한다
// (새로고침하면 꺼진 상태로 초기화됨 - 폰 쪽 상태와 항상 일치시키려면 서버가 상태를
// 들고 있어야 하는데, 이 두 토글은 그 정도로 중요하지 않다고 판단해 단순하게 둠).
let versionCheckEnabled = false;
let idShowing = false;

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

    if (status === 'offline') offlineIds.push(id);
  }
  lastDevices = data.devices;

  fileStatusCountEl.textContent =
    `파일: 정상 ${fileCounts.ok} / 불일치 ${fileCounts.mismatch} / 무응답 ${fileCounts.unknown}`;

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

  if (data.textPatternConfig && !editingTextPatternConfig) {
    textPatternContentEl.value = data.textPatternConfig.text;
    textPatternFgColorEl.value = data.textPatternConfig.fgColor;
    textPatternBgColorEl.value = data.textPatternConfig.bgColor;
    textPatternCharStaggerEl.value = data.textPatternConfig.charStaggerMs;
    textPatternFadeInEl.value = data.textPatternConfig.fadeInMs;
    textPatternHoldEl.value = data.textPatternConfig.holdMs;
    textPatternFadeOutEl.value = data.textPatternConfig.fadeOutMs;
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

  [textPatternContentEl, textPatternFgColorEl, textPatternBgColorEl, textPatternCharStaggerEl,
    textPatternFadeInEl, textPatternHoldEl, textPatternFadeOutEl,
    btnTextPatternStart, btnTextPatternStop].forEach((el) => {
    el.disabled = !isPattern;
  });
  textPatternControlsEl.classList.toggle('disabled', !isPattern);

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

function sendTextPatternConfig() {
  postJson('/api/text-pattern/config', {
    text: textPatternContentEl.value,
    fgColor: textPatternFgColorEl.value,
    bgColor: textPatternBgColorEl.value,
    charStaggerMs: Number(textPatternCharStaggerEl.value),
    fadeInMs: Number(textPatternFadeInEl.value),
    holdMs: Number(textPatternHoldEl.value),
    fadeOutMs: Number(textPatternFadeOutEl.value),
  }).catch((err) => console.error('[HTTP] 텍스트 패턴 설정 저장 실패', err));
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

[textPatternContentEl, textPatternFgColorEl, textPatternBgColorEl, textPatternCharStaggerEl,
  textPatternFadeInEl, textPatternHoldEl, textPatternFadeOutEl].forEach((el) => {
  el.addEventListener('focus', () => {
    editingTextPatternConfig = true;
  });
  el.addEventListener('blur', () => {
    editingTextPatternConfig = false;
  });
  el.addEventListener('change', sendTextPatternConfig);
});

btnTextPatternStart.addEventListener('click', () => {
  fetch('/api/text-pattern/start', { method: 'POST' }).catch((err) => console.error('[HTTP] 텍스트 패턴 시작 요청 실패', err));
});

btnTextPatternStop.addEventListener('click', () => {
  fetch('/api/text-pattern/stop', { method: 'POST' }).catch((err) => console.error('[HTTP] 텍스트 패턴 정지 요청 실패', err));
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

// 페이지 로드 시 저장된 AP 대수를 불러와 입력칸에 채운다.
fetch('/api/deploy-config')
  .then((res) => res.json())
  .then((data) => {
    if (data.ok && data.deployConfig) vrApCountEl.value = data.deployConfig.apCount;
  })
  .catch((err) => console.error('[HTTP] deploy-config 조회 실패', err));

btnVrSaveApCount.addEventListener('click', () => {
  const apCount = Number(vrApCountEl.value);
  if (!Number.isInteger(apCount) || apCount < 1) {
    window.alert('AP 대수는 1 이상의 정수로 입력하세요.');
    return;
  }
  postJson('/api/deploy-config', { apCount })
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) window.alert(`저장 실패: ${data.error}`);
    })
    .catch((err) => console.error('[HTTP] deploy-config 저장 실패', err));
});

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

connect();
