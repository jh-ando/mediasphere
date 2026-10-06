const RECONNECT_DELAY_MS = 3000;
const LOW_BATTERY_PCT = 20; // 충전 중인데도 이 아래면 "배터리 낮음" (충전 안 됨은 별도)
// 랜덤(지정색)의 최소 밝기 - 폰 MainActivity.RANDOM_MIN_VALUE와 같은 값이어야 한다.
const RANDOM_SHADE_MIN_BRIGHTNESS = 0.3;
// 인코딩 남은 시간은 서버가 이 개수 이상 끝난 뒤부터 보낸다(server.js ENCODE_ETA_MIN_DONE)
const TOAST_MS = 2800;

const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── 요소
const serverTimeEl = $('server-time');
const btnShowId = $('btn-show-id');
const nowDotEl = $('now-dot');
const nowTitleEl = $('now-title');
const nowSubEl = $('now-sub');
const onlineEl = $('online');
const schedLineEl = $('sched-line');
const modeTabs = $$('.tabs .tab');
const modeLockedNoteEl = $('mode-locked-note');
const panels = $$('[data-panel]');

const tgVideo = $('tg-video');
const rsVideo = $('rs-video');
const videoNoteEl = $('video-note');

const kindBtns = $$('#kinds .kind');
const wayBtns = $$('#ways .way');
const ptBlinkEl = $('pt-blink');
const ptPlaylistEl = $('pt-playlist');
const patternColorEl = $('pattern-color');
const patternColorModeEl = $('pattern-color-mode');
const patternSaturationWrap = $('pattern-saturation-wrap');
const patternColorSaturationEl = $('pattern-color-saturation');
const patternIntervalEl = $('pattern-interval');
const patternDurationEl = $('pattern-duration');
const patternStepDelayWrap = $('pattern-step-delay-wrap');
const patternStepDelayEl = $('pattern-step-delay');
const patternShadeNoteEl = $('pattern-shade-note');
const tgBlink = $('tg-blink');
const rsBlink = $('rs-blink');

const playlistCuesEl = $('playlist-cues');
const playlistUnsavedEl = $('playlist-unsaved');
const playlistStatusEl = $('playlist-status');
const btnPlaylistAddCue = $('btn-playlist-add-cue');
const btnPlaylistSave = $('btn-playlist-save');
const tgPlaylist = $('tg-playlist');

const textContentEl = $('text-content');
const textFontEl = $('text-font');
const textFontSizeEl = $('text-font-size');
const textColorEl = $('text-color');
const textBgColorEl = $('text-bg-color');
const textAlignEl = $('text-align');
const textDirectionEl = $('text-direction');
const textSpeedEl = $('text-speed');
const tgText = $('tg-text');
const rsText = $('rs-text');

const alertsEl = $('alerts');
const idListEl = $('id-list');
const idListTitleEl = $('id-list-title');
const idListNumsEl = $('id-list-nums');
const gridEl = $('device-grid');

const adminEl = $('admin');
const sumSchedEl = $('sum-sched');
const sumReplaceEl = $('sum-replace');
const sumVersionEl = $('sum-version');
const stSchedEl = $('st-sched');
const scheduleEnabledEl = $('schedule-enabled');
const scheduleStartH = $('schedule-start-h');
const scheduleStartM = $('schedule-start-m');
const scheduleEndH = $('schedule-end-h');
const scheduleEndM = $('schedule-end-m');
const scheduleDayBtns = $$('#schedule-closed-days button');
const btnScheduleSave = $('btn-schedule-save');
const scheduleStatusEl = $('schedule-status');

const stVersionEl = $('st-version');
const verLatestEl = $('ver-latest');
const verOkEl = $('ver-ok');
const verOldEl = $('ver-old');
const verUnknownEl = $('ver-unknown');
const otaStatusEl = $('ota-status');
const btnVersionToggle = $('btn-version-toggle');

const stReplaceEl = $('st-replace');
const replaceRuleEl = $('replace-rule');
const vrModeEl = $('vr-mode');
const vrFileEl = $('vr-file');
const btnVrStart = $('btn-vr-start');
const replaceProgressEl = $('replace-progress');
const vrStepEls = $$('#vr-steps li');
const vrNumsEl = $('vr-nums');
const vrBarEl = $('vr-bar');
const vrProgressNoteEl = $('vr-progress-note');
const btnVrCancel = $('btn-vr-cancel');
const vrErrorEl = $('vr-error');
const fsOkEl = $('fs-ok');
const fsMisEl = $('fs-mis');
const fsNaEl = $('fs-na');
const vrLogWrap = $('vr-log-wrap');
const vrLogEl = $('vr-log');

const restartDeviceIdsEl = $('restart-device-ids');
const btnRestartSelected = $('btn-restart-selected');
const btnRestartAll = $('btn-restart-all');
const btnRebootSelected = $('btn-reboot-selected');

// ── 표시 이름
const RUNNING_LABEL = {
  video: '영상 재생', playlist: '재생목록', textPattern: '텍스트 패턴',
  textScroll: '텍스트', pattern: '전체 점멸', sequence: '순차 점멸',
};
const MODE_LABEL = { video: '영상', pattern: '패턴', text: '텍스트' };
// 불일치 셀 툴팁 사유 - 서버 fileReason(폰 wall/error 사유 또는 OLD_FILE)
const FILE_REASON_LABEL = {
  OLD_FILE: '옛 영상 파일',
  DOWNLOAD_FAILED: '다운로드 실패',
  CHECKSUM_MISMATCH: '체크섬 불일치(서버 파일 확인 필요)',
  RENAME_FAILED: '파일 교체 실패',
};
const REBOOT_ERROR_LABEL = { NOT_DEVICE_OWNER: 'Device Owner 아님(재등록 필요)' };

// 문제 알림 종류 - 순서대로 칩을 그린다. icon은 그리드 칸과 같은 모양의 작은 칸.
const PROBLEMS = [
  { key: 'off', label: '연결 끊김', icon: 'mini off', title: '연결 끊긴 폰' },
  { key: 'mis', label: '영상 파일 불일치', icon: 'mini mis', title: '영상 파일이 다른 폰' },
  { key: 'perr', label: '재생 오류', icon: 'mini perr', title: '재생 오류 폰' },
  { key: 'rerr', label: '재부팅 실패', icon: 'mini perr', title: '재부팅 요청이 실패한 폰' },
  { key: 'batt', label: '충전 안 됨', icon: 'mini batt', title: '충전 안 되는 폰' },
  { key: 'low', label: '배터리 낮음', icon: 'mini low', title: '배터리 낮은 폰' },
];

// ── 상태
let latest = null; // 마지막 STATUS_UPDATE
// 패턴/텍스트 설정 입력 중에는 STATUS_UPDATE로 값이 덮어써지지 않도록 막는다.
let editingPatternConfig = false;
let editingTextConfig = false;
let scheduleDirty = false;
// 패턴: 먼저 "바로 점멸 / 재생목록"을 고르고, 바로 점멸이면 "전체 동시 / 순차"를 고른다.
let patternKind = 'blink';
let blinkWay = 'all';
// 버전 확인/ID 표시 토글 - 서버에 별도로 묻지 않고 이 페이지에서만 기억한다(새로고침하면 꺼짐).
let versionCheckEnabled = false;
let idShowing = false;
// 재생목록 - 이 페이지에서 편집하다가 "저장"해야 서버에 반영된다. 재생 중엔 편집을 막는다.
let playlistCues = [];
let playlistPlaying = false;
let playlistCurrentCueIndex = -1;
let playlistDirty = false;
// 문제 알림 필터(누른 칩) - 그리드에서 그 폰만 남기고 번호 목록을 보여준다.
let activeFilter = null;
let problemIds = {};
let lastAlertsSignature = '';
let vrLastStep = 'idle';

// 셀 DOM은 최초 STATUS_UPDATE 때 한 번만 만들고, 이후엔 상태가 바뀐 셀만 갱신한다.
let cellRefs = null;
let lastDevices = {};
let lastColor = null;

// ── 알림(토스트) / 확인창 - 브라우저 기본 alert/confirm 대신
let toastTimer = null;
function showToast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, TOAST_MS);
}

let modalResolve = null;
function confirmModal({ title, body, okLabel = '확인', danger = false }) {
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  const ok = $('modal-ok');
  ok.textContent = okLabel;
  ok.className = danger ? 'btn-sm red' : 'btn-sm green';
  document.querySelector('#modal .modal').classList.toggle('danger-modal', danger);
  $('modal').hidden = false;
  // 위험한 동작은 실수로 Enter를 눌러도 실행되지 않게 "취소"에 먼저 초점을 둔다.
  (danger ? $('modal-cancel') : ok).focus();
  return new Promise((resolve) => { modalResolve = resolve; });
}
function closeModal(result) {
  $('modal').hidden = true;
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}
$('modal-ok').addEventListener('click', () => closeModal(true));
$('modal-cancel').addEventListener('click', () => closeModal(false));
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(false); });

// POST 요청 공용 - 실패하면 서버가 준 사유를 토스트로 보여주고 null, 성공하면 응답 JSON.
async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* 본문 없는 응답 */ }
    if (!res.ok || data.ok === false || data.success === false) {
      showToast(data.error || '요청이 거부되었습니다.', true);
      return null;
    }
    return data;
  } catch (err) {
    console.error('[HTTP] 요청 실패', url, err);
    showToast('서버에 연결할 수 없습니다. 네트워크를 확인하세요.', true);
    return null;
  }
}

// ── 단위/형식
const msToSec = (ms) => String(+(Number(ms) / 1000).toFixed(3));
const secToMs = (sec) => Math.round(Number(sec) * 1000);
function formatClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function formatDuration(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min < 1) return '1분 미만';
  if (min < 60) return `${min}분`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분`;
}
function setPill(el, cls, text) {
  el.className = `pill ${cls}`.trim();
  el.innerHTML = '<i></i>';
  el.append(text);
}

// ── 기기 그리드
function ensureGrid(deviceIds) {
  if (cellRefs) return;
  cellRefs = {};
  deviceIds.forEach((id) => {
    const cell = document.createElement('div');
    cell.className = 'device-cell offline';
    cell.title = `#${id}`;
    gridEl.appendChild(cell);
    cellRefs[id] = cell;
  });
}

// ── STATUS_UPDATE (1초마다)
function applyStatusUpdate(data) {
  latest = data;
  ensureGrid(Object.keys(data.devices));

  const currentColorHex = data.currentColor && data.currentColor.color;
  const fileStatus = data.fileStatus || {};
  const fileReason = data.fileReason || {};
  const playerError = data.playerError || {};
  const rebootError = data.rebootError || {};
  const otaStatus = data.otaStatus || {};
  const versions = data.versions || {};
  const battery = data.battery || {};
  const latestVersionCode = data.latestVersionCode;

  const fileCounts = { ok: 0, mismatch: 0, unknown: 0 };
  const versionCounts = { latest: 0, old: 0, unknown: 0 };
  const otaCounts = { idle: 0, downloading: 0, installing: 0, done: 0, failed: 0 };
  const ids = { off: [], mis: [], perr: [], rerr: [], batt: [], low: [] };

  for (const id of Object.keys(data.devices)) {
    const status = data.devices[id];
    const cell = cellRefs[id];

    // 연결 상태가 바뀐 칸만 다시 칠한다(439칸 전체 리렌더 금지)
    if (lastDevices[id] !== status && cell) {
      cell.classList.toggle('online', status === 'online');
      cell.classList.toggle('offline', status === 'offline');
      cell.style.backgroundColor = status === 'online' && currentColorHex ? currentColorHex : '';
    }
    if (status === 'offline') ids.off.push(id);

    const fStatus = fileStatus[id] || 'unknown';
    fileCounts[fStatus] = (fileCounts[fStatus] || 0) + 1;
    if (fStatus === 'mismatch') ids.mis.push(id);

    const oStatus = otaStatus[id] || 'idle';
    otaCounts[oStatus] = (otaCounts[oStatus] || 0) + 1;

    // 버전 비교는 latestVersionCode(app-version.json)를 알 때만 의미가 있다.
    const v = versions[id];
    const vKey = typeof v !== 'number' || typeof latestVersionCode !== 'number'
      ? 'unknown'
      : (v >= latestVersionCode ? 'latest' : 'old');
    versionCounts[vKey] += 1;

    // 상시 USB 전원 설치라 "충전 중인지"가 가장 급한 신호 - 충전 안 됨이 배터리 낮음보다 우선.
    const b = battery[id];
    const batteryKey = !b ? 'unknown' : !b.charging ? 'notCharging' : b.pct < LOW_BATTERY_PCT ? 'low' : 'ok';
    if (batteryKey === 'notCharging') ids.batt.push(id);
    if (batteryKey === 'low') ids.low.push(id);
    const pError = playerError[id];
    if (pError) ids.perr.push(id);
    const rError = rebootError[id];
    if (rError) ids.rerr.push(id);

    if (cell) {
      cell.classList.toggle('mismatch', fStatus === 'mismatch');
      cell.classList.toggle('version-mismatch', versionCheckEnabled && vKey === 'old');
      cell.classList.toggle('battery-not-charging', batteryKey === 'notCharging');
      cell.classList.toggle('battery-low', batteryKey === 'low');
      cell.classList.toggle('player-error', Boolean(pError));

      const tips = [`#${id} · ${status === 'online' ? '연결됨' : '연결 끊김'}`];
      if (b) tips.push(`배터리 ${b.pct}% (${b.charging ? '충전 중' : '충전 안 됨'})`);
      if (typeof v === 'number') tips.push(`앱 v${v}${vKey === 'old' ? ' (구버전)' : ''}`);
      if (fStatus === 'mismatch') {
        const reason = fileReason[id];
        tips.push(`영상 파일 불일치 - ${FILE_REASON_LABEL[reason] || reason || '사유 없음'}`);
      }
      if (pError) tips.push(`재생 오류 - ${pError}`);
      if (rError) tips.push(`재부팅 요청 실패 - ${REBOOT_ERROR_LABEL[rError] || rError}`);
      cell.title = tips.join('\n');
    }
  }
  lastDevices = data.devices;

  // 현재 색이 바뀌면 상태가 그대로인 연결된 칸들도 다시 칠한다.
  if (currentColorHex !== lastColor) {
    Object.keys(data.devices).forEach((id) => {
      if (data.devices[id] !== 'online') return;
      const cell = cellRefs[id];
      if (cell) cell.style.backgroundColor = currentColorHex || '';
    });
    lastColor = currentColorHex;
  }

  problemIds = ids;
  renderAlerts();
  applyFilter();

  onlineEl.innerHTML = '';
  onlineEl.append(String(data.online), Object.assign(document.createElement('span'), { textContent: ` / ${data.total}대 연결` }));
  if (data.schedule) serverTimeEl.textContent = data.schedule.serverTimeText;

  renderNow(data);
  renderModes(data);
  renderVideoPanel(data);
  renderPatternPanel(data);
  renderTextPanel(data);
  if (data.schedule) renderSchedule(data.schedule);
  renderVersion(versionCounts, otaCounts, latestVersionCode);
  renderReplace(data, fileCounts);
}

// ── 지금 상태
function renderNow(data) {
  const running = data.running;
  const vr = data.videoReplace || {};
  let dot = '';
  let title;
  let sub = '';

  if (data.replacing) {
    dot = 'busy';
    title = '영상 교체 중';
    sub = data.deploy ? '새 영상을 폰에 배포하는 중입니다' : '새 영상을 준비하는 중입니다 (관리 > 영상 교체에서 진행 상황 확인)';
  } else if (data.idleMode) {
    dot = 'idle';
    title = '절전 (화면 꺼짐)';
    const s = data.schedule;
    sub = s && s.enabled && !s.operating ? '운영 시간이 아닙니다' : '절전 모드로 꺼 둔 상태입니다';
  } else if (running === 'video') {
    title = '영상 재생 중';
    sub = `재생 ${formatClock(data.timecode)} · 반복 재생`;
  } else if (running === 'playlist') {
    title = playlistCurrentCueIndex >= 0 && playlistCues.length > 0
      ? `패턴 · 재생목록 ${playlistCurrentCueIndex + 1}/${playlistCues.length}`
      : '패턴 · 재생목록 재생 중';
    sub = '저장된 큐를 순서대로 반복합니다';
  } else if (running === 'pattern' || running === 'sequence') {
    title = `패턴 · ${RUNNING_LABEL[running]} 중`;
  } else if (running === 'textScroll') {
    title = '텍스트 흐르는 중';
    sub = latest && latest.textScrollConfig ? `"${latest.textScrollConfig.text.split('\n')[0]}"` : '';
  } else if (running === 'textPattern') {
    title = '텍스트 패턴 표시 중';
  } else {
    dot = 'idle';
    title = `${MODE_LABEL[data.currentMode] || ''} 모드 · 정지`;
    sub = '아래에서 시작할 수 있습니다';
  }
  if (vr.step === 'error' && !data.replacing) sub = `${sub ? `${sub} · ` : ''}최근 영상 교체 실패`;

  nowDotEl.className = `now-dot ${dot}`.trim();
  nowTitleEl.textContent = title;
  nowSubEl.textContent = sub;

  const s = data.schedule;
  schedLineEl.innerHTML = '';
  if (s && s.enabled) {
    const b = document.createElement('b');
    b.textContent = `${s.start}~${s.end}`;
    const next = s.nextAction
      ? ` · 다음 ${s.nextAction.atText} ${s.nextAction.type === 'play' ? '재생 시작' : '절전 전환'}`
      : '';
    schedLineEl.append('운영 시간 ', b, ` · ${s.operating ? '운영 중' : '운영 시간 아님'}${next}`);
  } else {
    schedLineEl.textContent = '운영 시간 타이머 꺼짐';
  }
}

// ── 모드 선택
function currentModeKey(data) {
  return data.idleMode ? 'idle' : data.currentMode;
}

function renderModes(data) {
  const mode = currentModeKey(data);
  const locked = Boolean(data.running) || Boolean(data.replacing);
  modeTabs.forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.mode === mode));
    t.disabled = locked && t.dataset.mode !== mode;
  });
  panels.forEach((p) => { p.hidden = p.dataset.panel !== mode; });

  modeLockedNoteEl.hidden = !locked;
  if (data.replacing) {
    modeLockedNoteEl.textContent = '영상 교체 중에는 모드를 바꾸거나 재생할 수 없습니다';
  } else if (data.running) {
    modeLockedNoteEl.textContent = `${RUNNING_LABEL[data.running] || data.running} 중에는 모드를 바꿀 수 없습니다 · 먼저 정지하세요`;
  }
}

modeTabs.forEach((t) => t.addEventListener('click', () => {
  if (t.disabled || t.getAttribute('aria-selected') === 'true') return;
  if (t.dataset.mode === 'idle') post('/api/idle');
  else post('/api/mode', { mode: t.dataset.mode });
}));

// ── 재생/정지 한 버튼 공용
function setToggle(btn, runStateEl, on, onLabel, offLabel) {
  btn.classList.toggle('on', on);
  btn.textContent = on ? onLabel : offLabel;
  if (runStateEl) {
    runStateEl.classList.toggle('on', on);
    runStateEl.querySelector('span').textContent = on ? '실행 중' : '정지됨';
  }
}

// ── 영상
function renderVideoPanel(data) {
  const playing = data.playState === 'playing';
  setToggle(tgVideo, rsVideo, playing, '■ 영상 정지', '▶ 영상 재생');
  tgVideo.disabled = Boolean(data.replacing) && !playing;
  videoNoteEl.hidden = !data.replacing;
  videoNoteEl.textContent = '영상 교체가 끝나면 재생할 수 있습니다';
}

tgVideo.addEventListener('click', async () => {
  const playing = tgVideo.classList.contains('on');
  const res = await post(playing ? '/api/stop' : '/api/play');
  if (res) showToast(playing ? '영상을 정지했습니다' : '영상 재생을 시작했습니다 (1초 뒤 동시 시작)');
});

// ── 패턴
function renderPatternPanel(data) {
  const running = data.running;
  const blinkRunning = running === 'pattern' || running === 'sequence';

  // 실행 중인 쪽을 화면에도 맞춘다(다른 PC에서 시작했어도 보이게)
  if (running === 'playlist') patternKind = 'playlist';
  if (blinkRunning) {
    patternKind = 'blink';
    blinkWay = running === 'sequence' ? 'sequence' : 'all';
  }
  applyPatternKindUi();
  kindBtns.forEach((k) => {
    k.disabled = (running === 'playlist' && k.dataset.kind !== 'playlist')
      || (blinkRunning && k.dataset.kind !== 'blink');
  });
  wayBtns.forEach((w) => { w.disabled = blinkRunning && w.dataset.way !== blinkWay; });

  if (data.patternConfig && !editingPatternConfig) {
    const c = data.patternConfig;
    patternColorEl.value = c.color;
    patternIntervalEl.value = msToSec(c.interval);
    patternDurationEl.value = msToSec(c.duration);
    patternStepDelayEl.value = msToSec(c.stepDelay);
    patternColorModeEl.value = c.colorMode || 'fixed';
    patternColorSaturationEl.value = c.colorSaturation ?? 100;
    applyPatternColorModeUi();
  }

  setToggle(tgBlink, rsBlink, blinkRunning, '■ 점멸 정지', '▶ 점멸 시작');
  setToggle(tgPlaylist, null, playlistPlaying, '■ 재생목록 정지', '▶ 재생목록 재생');
  tgPlaylist.disabled = !playlistPlaying && (playlistCues.length === 0 || blinkRunning);
}

function applyPatternKindUi() {
  kindBtns.forEach((k) => k.setAttribute('aria-pressed', String(k.dataset.kind === patternKind)));
  wayBtns.forEach((w) => w.setAttribute('aria-pressed', String(w.dataset.way === blinkWay)));
  ptBlinkEl.hidden = patternKind !== 'blink';
  ptPlaylistEl.hidden = patternKind !== 'playlist';
  patternStepDelayWrap.hidden = blinkWay !== 'sequence';
}

kindBtns.forEach((k) => k.addEventListener('click', () => {
  if (k.disabled) return;
  patternKind = k.dataset.kind;
  applyPatternKindUi();
}));
wayBtns.forEach((w) => w.addEventListener('click', () => {
  if (w.disabled) return;
  blinkWay = w.dataset.way;
  applyPatternKindUi();
}));

// 지정 색을 쓰는 색상 모드 - "고정"과 "랜덤(지정색)"(그 색의 톤 안에서 밝기만 무작위).
function colorModeUsesColor(mode) {
  return mode === 'fixed' || mode === 'randomShade';
}

// "#RRGGBB"의 밝기(HSV 명도, 0~1) - 폰이 쓰는 Color.colorToHSV의 V와 같은 계산.
function hexBrightness(hex) {
  const n = parseInt(hex.slice(1), 16);
  return Math.max((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff) / 255;
}

// 랜덤(지정색) 안내 - 지정 색이 최소 밝기 이하면 폰이 무작위 없이 그 색 그대로 쓰므로 경고한다.
function shadeNote(mode, hex) {
  if (mode !== 'randomShade') return null;
  const brightness = hexBrightness(hex);
  if (brightness <= RANDOM_SHADE_MIN_BRIGHTNESS) {
    return { warn: true, text: `지정 색이 너무 어두워(밝기 ${Math.round(brightness * 100)}%) 밝기가 변하지 않습니다 - 30%보다 밝은 색을 고르세요` };
  }
  return { warn: false, text: `폰마다 밝기 30%~${Math.round(brightness * 100)}% 사이에서 깜빡일 때마다 달라집니다` };
}

// 색상 모드에 따라 색상 선택/채도 칸을 켜고 끈다 - 채도는 랜덤(컬러)일 때만 보인다.
function applyPatternColorModeUi() {
  const mode = patternColorModeEl.value;
  patternColorEl.disabled = !colorModeUsesColor(mode);
  patternSaturationWrap.hidden = mode !== 'random';
  const note = shadeNote(mode, patternColorEl.value);
  patternShadeNoteEl.hidden = !note;
  if (note) {
    patternShadeNoteEl.textContent = note.text;
    patternShadeNoteEl.classList.toggle('warn', note.warn);
  }
}

function sendPatternConfig() {
  return post('/api/pattern/config', {
    color: patternColorEl.value,
    interval: secToMs(patternIntervalEl.value),
    duration: secToMs(patternDurationEl.value),
    stepDelay: secToMs(patternStepDelayEl.value),
    colorMode: patternColorModeEl.value,
    colorSaturation: Number(patternColorSaturationEl.value),
  });
}

[patternColorEl, patternIntervalEl, patternDurationEl, patternStepDelayEl, patternColorModeEl, patternColorSaturationEl]
  .forEach((el) => {
    el.addEventListener('focus', () => { editingPatternConfig = true; });
    el.addEventListener('blur', () => { editingPatternConfig = false; });
    el.addEventListener('change', sendPatternConfig);
  });
patternColorModeEl.addEventListener('change', applyPatternColorModeUi);
patternColorEl.addEventListener('input', applyPatternColorModeUi);

tgBlink.addEventListener('click', async () => {
  const running = latest && latest.running;
  if (running === 'pattern' || running === 'sequence') {
    const res = await post(running === 'sequence' ? '/api/sequence/stop' : '/api/pattern/stop');
    if (res) showToast('점멸을 정지했습니다');
    return;
  }
  // 입력 중이던 값이 반영된 뒤 시작하도록 설정부터 저장한다.
  if (!(await sendPatternConfig())) return;
  const res = await post(blinkWay === 'sequence' ? '/api/sequence/start' : '/api/pattern/start');
  if (res) showToast(blinkWay === 'sequence' ? '순차 점멸을 시작했습니다' : '전체 점멸을 시작했습니다');
});

// ── 재생목록
// 큐 배열은 이 페이지가 들고 있다가 "저장"해야 서버에 반영된다(여러 값을 맞춘 뒤 한 번에 저장).
// 간격/지속/다음 폰 간격은 화면에선 초, 저장은 서버 형식인 ms로 한다.
function markPlaylistDirty() {
  playlistDirty = true;
  playlistUnsavedEl.hidden = false;
}

function createCueRow(cue, index) {
  const row = document.createElement('div');
  row.className = 'playlist-cue-row';
  row.dataset.index = String(index);

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = cue.color;
  colorInput.title = '색상';

  const colorModeSelect = document.createElement('select');
  colorModeSelect.innerHTML = '<option value="fixed">고정</option>'
    + '<option value="random">랜덤(컬러)</option>'
    + '<option value="randomGray">랜덤(흑백)</option>'
    + '<option value="randomShade">랜덤(지정색)</option>';
  colorModeSelect.value = cue.colorMode || 'fixed';

  const saturationInput = document.createElement('input');
  saturationInput.type = 'number';
  saturationInput.min = '0';
  saturationInput.max = '100';
  saturationInput.step = '5';
  saturationInput.title = '채도(%) - 랜덤(컬러)일 때만 적용';
  saturationInput.value = cue.colorSaturation ?? 100;

  // 랜덤(지정색) 큐는 색상 칸 툴팁으로 밝기 범위를, 너무 어두우면 노란 테두리로 경고한다.
  const updateCueColorUi = () => {
    const mode = colorModeSelect.value;
    colorInput.dataset.usable = String(colorModeUsesColor(mode));
    saturationInput.dataset.usable = String(mode === 'random');
    const note = shadeNote(mode, colorInput.value);
    colorInput.title = note ? note.text : '색상';
    colorInput.classList.toggle('shade-too-dark', Boolean(note && note.warn));
  };
  colorInput.addEventListener('input', () => {
    playlistCues[index].color = colorInput.value;
    updateCueColorUi();
    markPlaylistDirty();
  });
  colorModeSelect.addEventListener('change', () => {
    playlistCues[index].colorMode = colorModeSelect.value;
    updateCueColorUi();
    updatePlaylistEditability();
    markPlaylistDirty();
  });
  saturationInput.addEventListener('change', () => {
    playlistCues[index].colorSaturation = Number(saturationInput.value);
    markPlaylistDirty();
  });
  updateCueColorUi();

  const secInput = (field, min, step, title) => {
    const el = document.createElement('input');
    el.type = 'number';
    el.min = min;
    el.step = step;
    el.title = title;
    el.value = msToSec(cue[field]);
    el.addEventListener('change', () => {
      playlistCues[index][field] = secToMs(el.value);
      markPlaylistDirty();
    });
    return el;
  };
  const intervalInput = secInput('interval', '0.05', '0.1', '깜빡임 간격(초)');
  const durationInput = secInput('duration', '0.5', '0.5', '지속 시간(초) - 순차는 이 큐 전체가 지속되는 시간');
  const stepDelayInput = secInput('stepDelay', '0', '0.05', '다음 폰까지 간격(초) - 순차일 때만 쓰임');

  const modeSelect = document.createElement('select');
  modeSelect.innerHTML = '<option value="all">전체 동시</option><option value="sequence">순차</option>';
  modeSelect.value = cue.mode;
  modeSelect.addEventListener('change', () => {
    playlistCues[index].mode = modeSelect.value;
    stepDelayInput.dataset.usable = String(modeSelect.value === 'sequence');
    updatePlaylistEditability();
    markPlaylistDirty();
  });
  stepDelayInput.dataset.usable = String(cue.mode === 'sequence');

  const moveUpBtn = document.createElement('button');
  moveUpBtn.type = 'button';
  moveUpBtn.textContent = '↑';
  moveUpBtn.title = '위로 이동';
  moveUpBtn.addEventListener('click', () => {
    [playlistCues[index - 1], playlistCues[index]] = [playlistCues[index], playlistCues[index - 1]];
    markPlaylistDirty();
    renderPlaylistCues();
  });

  const moveDownBtn = document.createElement('button');
  moveDownBtn.type = 'button';
  moveDownBtn.textContent = '↓';
  moveDownBtn.title = '아래로 이동';
  moveDownBtn.addEventListener('click', () => {
    [playlistCues[index], playlistCues[index + 1]] = [playlistCues[index + 1], playlistCues[index]];
    markPlaylistDirty();
    renderPlaylistCues();
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'red';
  deleteBtn.textContent = '삭제';
  deleteBtn.addEventListener('click', () => {
    playlistCues.splice(index, 1);
    markPlaylistDirty();
    renderPlaylistCues();
  });

  const label = document.createElement('span');
  label.textContent = String(index + 1);

  row.append(label, colorInput, colorModeSelect, saturationInput, intervalInput, durationInput, stepDelayInput,
    modeSelect, moveUpBtn, moveDownBtn, deleteBtn);
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

// 재생 중엔 편집 요소를 전부 막는다(서버도 저장을 거부한다). 재생→정지 때는 DOM을 다시
// 그리지 않고 이 함수만 불리므로, 꺼뒀던 요소를 여기서 직접 다시 켠다. 이 큐에서 쓰이지 않는
// 칸(data-usable=false: 고정이 아닌데 색상, 랜덤(컬러)가 아닌데 채도, 순차가 아닌데 다음 폰)도 끈다.
function updatePlaylistEditability() {
  const locked = playlistPlaying;
  const rows = [...playlistCuesEl.querySelectorAll('.playlist-cue-row[data-index]')];
  rows.forEach((row, index) => {
    row.querySelectorAll('input, select, button').forEach((el) => {
      el.disabled = locked || el.dataset.usable === 'false';
    });
    if (!locked) {
      const buttons = row.querySelectorAll('button');
      buttons[0].disabled = index === 0;
      buttons[1].disabled = index === rows.length - 1;
    }
  });
  btnPlaylistAddCue.disabled = locked;
  btnPlaylistSave.disabled = locked;
}

function applyPlaylistProgress(data) {
  playlistPlaying = Boolean(data.playing);
  playlistCurrentCueIndex = typeof data.currentCueIndex === 'number' ? data.currentCueIndex : -1;
  playlistStatusEl.hidden = !playlistPlaying;
  playlistStatusEl.textContent = playlistPlaying && playlistCurrentCueIndex >= 0
    ? `재생 중 · ${playlistCurrentCueIndex + 1}/${playlistCues.length}`
    : '재생 중';
  playlistCuesEl.querySelectorAll('.playlist-cue-row').forEach((row) => {
    row.classList.toggle('active', playlistPlaying && Number(row.dataset.index) === playlistCurrentCueIndex);
  });
  updatePlaylistEditability();
  setToggle(tgPlaylist, null, playlistPlaying, '■ 재생목록 정지', '▶ 재생목록 재생');
}

async function savePlaylist() {
  const res = await post('/api/pattern/playlist', { cues: playlistCues });
  if (!res) return false;
  playlistDirty = false;
  playlistUnsavedEl.hidden = true;
  return true;
}

btnPlaylistAddCue.addEventListener('click', () => {
  playlistCues.push({
    color: '#ffffff', colorMode: 'fixed', colorSaturation: 100,
    interval: 500, duration: 3000, stepDelay: 200, mode: 'all',
  });
  markPlaylistDirty();
  renderPlaylistCues();
});

btnPlaylistSave.addEventListener('click', async () => {
  if (await savePlaylist()) showToast('재생목록을 저장했습니다');
});

tgPlaylist.addEventListener('click', async () => {
  if (playlistPlaying) {
    if (await post('/api/pattern/playlist/stop')) showToast('재생목록을 정지했습니다');
    return;
  }
  if (playlistDirty) {
    const ok = await confirmModal({
      title: '저장하지 않은 변경이 있습니다',
      body: '재생목록은 저장된 내용으로 재생됩니다. 지금 편집한 내용을 저장하고 재생할까요?',
      okLabel: '저장하고 재생',
    });
    if (!ok || !(await savePlaylist())) return;
  }
  if (await post('/api/pattern/playlist/play')) showToast('재생목록 재생을 시작했습니다');
});

// ── 텍스트
function renderTextPanel(data) {
  if (data.textScrollConfig && !editingTextConfig) {
    const c = data.textScrollConfig;
    textContentEl.value = c.text;
    textFontEl.value = c.font;
    textFontSizeEl.value = c.fontSize;
    textColorEl.value = c.color;
    textBgColorEl.value = c.bgColor;
    textAlignEl.value = c.align;
    textDirectionEl.value = c.direction;
    textSpeedEl.value = c.speed;
  }
  setToggle(tgText, rsText, data.running === 'textScroll', '■ 텍스트 정지', '▶ 텍스트 시작');
}

function sendTextConfig() {
  return post('/api/text/config', {
    text: textContentEl.value,
    font: textFontEl.value,
    fontSize: Number(textFontSizeEl.value),
    color: textColorEl.value,
    bgColor: textBgColorEl.value,
    align: textAlignEl.value,
    direction: textDirectionEl.value,
    speed: Number(textSpeedEl.value),
  });
}

[textContentEl, textFontEl, textFontSizeEl, textColorEl, textBgColorEl, textAlignEl, textDirectionEl, textSpeedEl]
  .forEach((el) => {
    el.addEventListener('focus', () => { editingTextConfig = true; });
    el.addEventListener('blur', () => { editingTextConfig = false; });
    el.addEventListener('change', sendTextConfig);
  });

tgText.addEventListener('click', async () => {
  if (latest && latest.running === 'textScroll') {
    if (await post('/api/text/stop')) showToast('텍스트를 정지했습니다');
    return;
  }
  if (!(await sendTextConfig())) return;
  if (await post('/api/text/start')) showToast('텍스트를 시작했습니다');
});

// ── 문제 알림 / 필터
function renderAlerts() {
  const shown = PROBLEMS.filter((p) => problemIds[p.key].length > 0);
  const signature = shown.map((p) => `${p.key}:${problemIds[p.key].length}`).join('|');
  if (activeFilter && !shown.some((p) => p.key === activeFilter)) activeFilter = null;
  if (signature === lastAlertsSignature) {
    syncAlertPressed();
    return;
  }
  lastAlertsSignature = signature;
  alertsEl.innerHTML = '';
  if (shown.length === 0) {
    const ok = document.createElement('span');
    ok.className = 'chip ok';
    ok.innerHTML = '<i class="mini"></i>';
    ok.append('모든 폰 정상');
    alertsEl.appendChild(ok);
  } else {
    shown.forEach((p) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip k-${p.key}`;
      chip.dataset.filter = p.key;
      chip.innerHTML = `<i class="${p.icon}"></i>`;
      const count = document.createElement('b');
      count.textContent = String(problemIds[p.key].length);
      chip.append(`${p.label} `, count);
      alertsEl.appendChild(chip);
    });
  }
  syncAlertPressed();
}

function syncAlertPressed() {
  alertsEl.classList.toggle('filtering', Boolean(activeFilter));
  alertsEl.querySelectorAll('[data-filter]').forEach((c) => {
    c.setAttribute('aria-pressed', String(c.dataset.filter === activeFilter));
  });
}

// 누른 알림의 폰만 그리드에 남기고, 그 번호 목록을 보여준다.
function applyFilter() {
  const set = activeFilter ? new Set(problemIds[activeFilter]) : null;
  Object.entries(cellRefs || {}).forEach(([id, cell]) => {
    cell.classList.toggle('dim', Boolean(set) && !set.has(id));
  });
  idListEl.hidden = !activeFilter;
  if (!activeFilter) return;
  const p = PROBLEMS.find((x) => x.key === activeFilter);
  const chip = alertsEl.querySelector(`[data-filter="${activeFilter}"]`);
  if (chip) idListEl.style.setProperty('--k', getComputedStyle(chip).getPropertyValue('--k'));
  idListTitleEl.textContent = `${p.title} ${problemIds[activeFilter].length}대`;
  idListNumsEl.textContent = problemIds[activeFilter].join(', ');
}

alertsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  activeFilter = activeFilter === chip.dataset.filter ? null : chip.dataset.filter;
  syncAlertPressed();
  applyFilter();
});

// 대시보드는 폐쇄망 http로 열리므로 navigator.clipboard(보안 연결 전용)가 없을 수 있다 - 그때는
// 예전 방식(execCommand)으로 복사하고, 그것도 안 되면 번호를 선택해 둔다.
$('btn-copy-ids').addEventListener('click', () => {
  const text = idListNumsEl.textContent;
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    ta.remove();
    if (copied) {
      showToast('폰 번호를 복사했습니다');
    } else {
      const r = document.createRange();
      r.selectNodeContents(idListNumsEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      showToast('번호를 선택했습니다 - Ctrl+C로 복사하세요');
    }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => showToast('폰 번호를 복사했습니다'), fallback);
  } else {
    fallback();
  }
});

$('btn-fill-ids').addEventListener('click', () => {
  restartDeviceIdsEl.value = idListNumsEl.textContent;
  adminEl.open = true;
  restartDeviceIdsEl.scrollIntoView({ block: 'center' });
  restartDeviceIdsEl.focus();
  showToast('관리 > 재시작·재부팅 칸에 번호를 넣었습니다');
});

// ── 관리: 운영 시간 (24시간 형식 선택 - PC 언어 설정과 무관하게 같게 보이도록)
function fillTimeOptions(select, count) {
  for (let i = 0; i < count; i += 1) {
    const v = String(i).padStart(2, '0');
    select.add(new Option(v, v));
  }
}
fillTimeOptions(scheduleStartH, 24);
fillTimeOptions(scheduleEndH, 24);
fillTimeOptions(scheduleStartM, 60);
fillTimeOptions(scheduleEndM, 60);

function setTimePick(hEl, mEl, hhmm) {
  const [h, m] = hhmm.split(':');
  hEl.value = h;
  mEl.value = m;
}

function renderSchedule(s) {
  if (!scheduleDirty) {
    scheduleEnabledEl.checked = s.enabled;
    setTimePick(scheduleStartH, scheduleStartM, s.start);
    setTimePick(scheduleEndH, scheduleEndM, s.end);
    scheduleDayBtns.forEach((b) => b.setAttribute('aria-pressed', String(s.closedDays.includes(Number(b.dataset.day)))));
  }

  const nextText = s.nextAction
    ? `다음 ${s.nextAction.atText} ${s.nextAction.type === 'play' ? '재생' : '절전'}`
    : '';
  if (!s.enabled) {
    setPill(stSchedEl, '', '꺼짐');
    setPill(sumSchedEl, '', '운영 시간 꺼짐');
  } else {
    setPill(stSchedEl, 'on', `켜짐${nextText ? ` · ${nextText}` : ''}`);
    setPill(sumSchedEl, 'on', '운영 시간 켜짐');
  }

  const parts = [];
  if (s.enabled) {
    parts.push(s.operating ? '지금은 운영 중입니다' : '지금은 운영 시간이 아닙니다');
    if (s.waitingForDeploy) parts.push('영상 교체가 끝나면 재생을 시작합니다');
  } else {
    parts.push('타이머를 켜면 저장하는 즉시 지금 시각 기준으로 적용됩니다');
  }
  scheduleStatusEl.textContent = parts.join(' · ');
}

[scheduleEnabledEl, scheduleStartH, scheduleStartM, scheduleEndH, scheduleEndM].forEach((el) => {
  el.addEventListener('change', () => { scheduleDirty = true; });
});
scheduleDayBtns.forEach((b) => b.addEventListener('click', () => {
  b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  scheduleDirty = true;
}));

btnScheduleSave.addEventListener('click', async () => {
  const body = {
    enabled: scheduleEnabledEl.checked,
    start: `${scheduleStartH.value}:${scheduleStartM.value}`,
    end: `${scheduleEndH.value}:${scheduleEndM.value}`,
    closedDays: scheduleDayBtns.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => Number(b.dataset.day)),
  };
  const turningOn = body.enabled && !(latest && latest.schedule && latest.schedule.enabled);
  if (turningOn) {
    const ok = await confirmModal({
      title: '운영 시간 타이머를 켤까요?',
      body: `${body.start}~${body.end}로 저장하면 지금 시각 기준으로 바로 적용됩니다.\n운영 시간이면 영상을 재생하고, 아니면 절전으로 바꿉니다.`,
      okLabel: '켜고 저장',
    });
    if (!ok) return;
  }
  if (await post('/api/schedule', body)) {
    scheduleDirty = false;
    showToast('운영 시간을 저장했습니다');
  }
});

// ── 관리: 앱 버전
function renderVersion(counts, ota, latestVersionCode) {
  if (typeof latestVersionCode !== 'number') {
    verLatestEl.textContent = '정보 없음';
    [verOkEl, verOldEl, verUnknownEl].forEach((el) => { el.textContent = '-'; });
    setPill(stVersionEl, '', '버전 정보 없음');
    setPill(sumVersionEl, '', '앱 버전 정보 없음');
  } else {
    verLatestEl.textContent = `v${latestVersionCode}`;
    verOkEl.textContent = `${counts.latest}대`;
    verOldEl.textContent = `${counts.old}대`;
    verOldEl.style.color = counts.old > 0 ? 'var(--warn)' : '';
    verUnknownEl.textContent = `${counts.unknown}대`;
    if (counts.old > 0) {
      setPill(stVersionEl, 'warn', `구버전 ${counts.old}대`);
      setPill(sumVersionEl, 'warn', `구버전 앱 ${counts.old}대`);
    } else if (counts.latest === 0) {
      // 연결된 폰이 없으면 버전을 알 수 없다 - "모두 최신"으로 오해하지 않게
      setPill(stVersionEl, '', '확인 불가');
      setPill(sumVersionEl, '', '앱 버전 확인 불가');
    } else {
      setPill(stVersionEl, 'on', '구버전 없음');
      setPill(sumVersionEl, 'on', '앱 구버전 없음');
    }
  }
  const busy = ota.downloading + ota.installing;
  otaStatusEl.textContent = busy > 0 || ota.failed > 0
    ? `앱 업데이트 진행: 받는 중 ${ota.downloading} · 설치 중 ${ota.installing} · 완료 ${ota.done} · 실패 ${ota.failed}`
    : '';
}

btnVersionToggle.addEventListener('click', () => {
  versionCheckEnabled = !versionCheckEnabled;
  btnVersionToggle.classList.toggle('active', versionCheckEnabled);
  btnVersionToggle.textContent = versionCheckEnabled ? '그리드 구버전 표시 끄기' : '그리드에 구버전 폰 표시';
  // 다음 STATUS_UPDATE(1초 안)에 파란 테두리로 반영된다.
});

// ── 관리: 영상 교체
const VR_STEPS = ['tiles', 'encoding', 'publish'];

function renderReplace(data, fileCounts) {
  const vr = data.videoReplace || { step: 'idle' };
  const deploy = data.deploy;
  const running = Boolean(data.replacing);

  // 단계: 배포 중이면 "폰 배포", 아니면 서버가 알려준 단계
  const stepNow = deploy ? 'publish' : vr.step;
  const nowIdx = VR_STEPS.indexOf(stepNow);
  vrStepEls.forEach((li, i) => {
    li.classList.toggle('done', running && nowIdx > i);
    li.classList.toggle('now', running && nowIdx === i);
  });
  replaceProgressEl.hidden = !running;
  btnVrCancel.hidden = !vr.running; // 취소는 서버 쪽 교체 작업(타일·인코딩)에만 - 폰 배포는 취소 대상 아님

  vrNumsEl.innerHTML = '';
  let pct = 0;
  let note = '';
  const addNum = (label, value) => {
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = value;
    span.append(`${label} `, b);
    vrNumsEl.appendChild(span);
  };
  if (deploy) {
    const c = deploy.counts;
    if (deploy.finished) {
      addNum('폰 배포', '완료 - 재검증 중');
      pct = 100;
    } else {
      addNum('배포 완료', `${deploy.settled} / ${deploy.total}대`);
      addNum('받는 중', `${deploy.inFlight}대`);
      addNum('대기', `${deploy.queued}대`);
      pct = deploy.total > 0 ? (deploy.settled / deploy.total) * 100 : 0;
    }
    if (c.failed + c.mismatch + c.timeout > 0) addNum('실패·시간초과', `${c.failed + c.mismatch + c.timeout}대`);
    note = '폰마다 새 영상 파일을 받는 중입니다(동시 20대씩).';
  } else if (vr.step === 'encoding') {
    addNum('인코딩', vr.encodeTotal > 0 ? `${vr.encodeDone} / ${vr.encodeTotal} 타일` : '시작 중');
    addNum('경과', formatDuration(vr.elapsedMs));
    addNum('예상 남은 시간', vr.etaMs != null ? `약 ${formatDuration(vr.etaMs)}` : '계산 중');
    pct = vr.encodeTotal > 0 ? (vr.encodeDone / vr.encodeTotal) * 100 : 0;
    note = '남은 시간은 지금까지의 인코딩 속도로 계산한 추정치입니다.';
  } else if (vr.step === 'tiles') {
    addNum('타일 좌표 계산 중 · 경과', formatDuration(vr.elapsedMs));
    note = '곧 인코딩이 시작됩니다.';
  } else if (vr.step === 'publish') {
    addNum('폰 배포', '시작 중');
  }
  vrBarEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  vrProgressNoteEl.textContent = note;

  // 상태 표시
  if (running) {
    const label = deploy ? `폰 배포 ${deploy.settled}/${deploy.total}`
      : vr.step === 'encoding' && vr.encodeTotal > 0 ? `인코딩 ${vr.encodeDone}/${vr.encodeTotal}`
        : '준비 중';
    setPill(stReplaceEl, 'busy', `교체 중 · ${label}`);
    setPill(sumReplaceEl, 'busy', `영상 교체 중 · ${label}`);
  } else if (vr.step === 'error') {
    setPill(stReplaceEl, 'err', '실패');
    setPill(sumReplaceEl, 'err', '영상 교체 실패');
  } else if (vr.step === 'done') {
    setPill(stReplaceEl, 'on', '최근 교체 완료');
    setPill(sumReplaceEl, '', '영상 교체 대기');
  } else {
    setPill(stReplaceEl, '', '대기 중');
    setPill(sumReplaceEl, '', '영상 교체 대기');
  }

  vrErrorEl.hidden = vr.step !== 'error';
  vrErrorEl.textContent = vr.step === 'error' ? `실패: ${vr.error || '알 수 없는 오류'} - 아래 로그를 확인하세요` : '';
  // 오류가 새로 나면 로그를 자동으로 펼친다
  if (vr.step === 'error' && vrLastStep !== 'error') vrLogWrap.open = true;
  vrLastStep = vr.step;

  // 시작 조건: 영상 모드 + 교체/배포 중 아님
  const inVideoMode = data.currentMode === 'video' && !data.idleMode;
  btnVrStart.disabled = running || !inVideoMode;
  if (!running && !inVideoMode) {
    replaceRuleEl.className = 'note warn';
    replaceRuleEl.textContent = '지금은 영상 모드가 아닙니다. 영상 모드로 바꾼 뒤 교체할 수 있습니다.';
  } else {
    replaceRuleEl.className = 'note';
    replaceRuleEl.textContent = '영상 모드에서만 교체할 수 있습니다. 교체하는 동안에는 영상 재생과 모드 변경이 막히고, 재생 중이면 정지됩니다.';
  }

  fsOkEl.textContent = String(fileCounts.ok);
  fsMisEl.textContent = String(fileCounts.mismatch);
  fsNaEl.textContent = String(fileCounts.unknown);
}

// VIDEO_REPLACE_PROGRESS - 로그 한 줄이 늘 때마다 온다(로그는 서버에서 최대 300줄로 잘림).
function applyVideoReplaceProgress(data) {
  const atBottom = vrLogEl.scrollTop + vrLogEl.clientHeight >= vrLogEl.scrollHeight - 4;
  vrLogEl.textContent = (data.log || []).join('\n');
  if (atBottom) vrLogEl.scrollTop = vrLogEl.scrollHeight;
}

btnVrStart.addEventListener('click', async () => {
  const file = vrFileEl.files[0];
  if (!file) {
    showToast('교체할 영상 파일을 먼저 고르세요', true);
    return;
  }
  const modeLabel = vrModeEl.options[vrModeEl.selectedIndex].textContent;
  const ok = await confirmModal({
    title: '영상을 교체할까요?',
    body: `"${file.name}"(${modeLabel})을(를) 439대 전체에 배포합니다.\n인코딩에 수십 분이 걸리고, 끝날 때까지 영상 재생과 모드 변경이 막힙니다. 재생 중이면 정지됩니다.`,
    okLabel: '교체 시작',
  });
  if (!ok) return;

  const formData = new FormData();
  formData.append('mode', vrModeEl.value);
  formData.append('video', file);
  btnVrStart.disabled = true;
  showToast('영상을 올리는 중입니다...');
  try {
    const res = await fetch('/api/video/replace', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showToast(`교체를 시작하지 못했습니다: ${data.error || '알 수 없는 오류'}`, true);
      btnVrStart.disabled = false;
      return;
    }
    showToast('영상 교체를 시작했습니다');
  } catch (err) {
    console.error('[HTTP] 영상 교체 요청 실패', err);
    showToast('영상을 올리지 못했습니다. 네트워크를 확인하세요.', true);
    btnVrStart.disabled = false;
  }
});

btnVrCancel.addEventListener('click', async () => {
  const ok = await confirmModal({
    title: '영상 교체를 취소할까요?',
    body: '지금까지 인코딩한 내용은 버려집니다. 폰에는 아무것도 바뀌지 않습니다.',
    okLabel: '교체 취소',
    danger: true,
  });
  if (ok && (await post('/api/video/replace/cancel'))) showToast('영상 교체를 취소했습니다');
});

// ── 관리: 재시작 / 재부팅
// 쉼표로 구분된 번호("1, 2,3")를 정수 배열로 - 비었으면 null, 잘못된 값이 섞이면 undefined.
function parseDeviceIds(text) {
  const parts = text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const ids = parts.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return undefined;
  return ids;
}

function readSelectedDeviceIds(emptyMessage) {
  const ids = parseDeviceIds(restartDeviceIdsEl.value);
  if (ids === undefined) {
    showToast('폰 번호는 쉼표로 구분된 숫자로 입력하세요 (예: 12, 15, 203)', true);
    restartDeviceIdsEl.focus();
    return null;
  }
  if (ids === null) {
    showToast(emptyMessage, true);
    restartDeviceIdsEl.focus();
    return null;
  }
  return ids;
}

btnRestartSelected.addEventListener('click', async () => {
  const ids = readSelectedDeviceIds('재시작할 폰 번호를 먼저 입력하세요');
  if (!ids) return;
  const ok = await confirmModal({
    title: '앱을 재시작할까요?',
    body: `${ids.length}대: ${ids.join(', ')}\n앱만 껐다 켭니다. 몇 초 뒤 다시 연결됩니다.`,
    okLabel: '앱 재시작',
  });
  if (ok && (await post('/api/restart-app', { targetDeviceIds: ids }))) showToast(`${ids.length}대 앱을 재시작했습니다`);
});

btnRestartAll.addEventListener('click', async () => {
  const ok = await confirmModal({
    title: '전체 앱을 재시작할까요?',
    body: '439대 모두 앱을 껐다 켭니다. 그동안 구체 화면이 잠깐 끊깁니다.',
    okLabel: '전체 앱 재시작',
  });
  if (ok && (await post('/api/restart-app'))) showToast('전체 앱을 재시작했습니다');
});

// 재부팅은 전체 버튼이 없다(서버도 대상 번호를 필수로 받는다).
btnRebootSelected.addEventListener('click', async () => {
  const ids = readSelectedDeviceIds('재부팅할 폰 번호를 먼저 입력하세요');
  if (!ids) return;
  const ok = await confirmModal({
    title: '폰을 재부팅할까요?',
    body: `${ids.length}대: ${ids.join(', ')}\n재부팅하는 1~2분 동안 이 폰들의 화면이 꺼지고, 다시 켜지면 앱이 자동으로 실행됩니다.`,
    okLabel: '재부팅',
    danger: true,
  });
  if (ok && (await post('/api/reboot-device', { targetDeviceIds: ids }))) {
    showToast(`${ids.length}대에 재부팅 명령을 보냈습니다 (1~2분 소요)`);
  }
});

// ── ID 표시 - duration 0 = 끌 때까지 계속 표시
btnShowId.addEventListener('click', async () => {
  const turningOn = !idShowing;
  const res = await post(turningOn ? '/api/show-id' : '/api/hide-id', turningOn ? { duration: 0 } : undefined);
  if (!res) return;
  idShowing = turningOn;
  btnShowId.textContent = idShowing ? 'ID 끄기' : 'ID 표시';
  btnShowId.classList.toggle('active', idShowing);
});

// ── 연결
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}`);
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'STATUS_UPDATE') applyStatusUpdate(data);
    if (data.type === 'VIDEO_REPLACE_PROGRESS') applyVideoReplaceProgress(data);
    if (data.type === 'PATTERN_PLAYLIST_PROGRESS') applyPlaylistProgress(data);
  });
  ws.addEventListener('close', () => {
    nowTitleEl.textContent = '서버 연결 끊김 - 다시 연결 중...';
    nowDotEl.className = 'now-dot idle';
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
  ws.addEventListener('error', () => ws.close());
}

// 페이지를 열 때 저장된 재생목록과 재생 상태를 불러온다.
fetch('/api/pattern/playlist')
  .then((res) => res.json())
  .then((data) => {
    if (!data.ok) return;
    playlistCues = data.patternPlaylist.cues || [];
    renderPlaylistCues();
    applyPlaylistProgress(data.playlistState || {});
  })
  .catch((err) => console.error('[HTTP] 재생목록 조회 실패', err));

// 주소 끝에 #admin을 붙여 열면 관리 영역을 펼친 채로 시작한다(즐겨찾기용).
if (location.hash === '#admin') adminEl.open = true;

applyPatternKindUi();
connect();
