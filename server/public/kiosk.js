const modeStressBtn = document.getElementById('mode-stress');
const modeColorBtn = document.getElementById('mode-color');
const stressInputEl = document.getElementById('stress-input');
const colorInputEl = document.getElementById('color-input');
const stressSliderEl = document.getElementById('stress-slider');
const stressValueEl = document.getElementById('stress-value');
const colorPickerEl = document.getElementById('color-picker');
const colorPreviewEl = document.getElementById('color-preview');
const btnSend = document.getElementById('btn-send');
const countdownEl = document.getElementById('countdown');
const historyBodyEl = document.getElementById('history-body');

let inputMode = 'stress'; // 'stress' | 'color'
let countdownTimer = null;
const history = []; // 최근 10건, 배열 앞쪽이 최신

function setInputMode(mode) {
  inputMode = mode;
  modeStressBtn.classList.toggle('active', mode === 'stress');
  modeColorBtn.classList.toggle('active', mode === 'color');
  stressInputEl.classList.toggle('hidden', mode !== 'stress');
  colorInputEl.classList.toggle('hidden', mode !== 'color');
  updatePreview();
}

// 서버 lib/stressColor.js의 hue 보간과 동일한 방향(파랑->보라->빨강)으로 맞춘 미리보기 근사치.
// 실제 매핑 결과는 서버 응답의 color 값이 정확하다 - 이건 슬라이더를 움직일 때 즉각 피드백용.
function approxStressColor(stress) {
  const h1 = 200;
  const h2 = 0;
  let diff = h2 - h1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  const h = (h1 + diff * stress + 360) % 360;
  const s = 70 + (80 - 70) * stress;
  const l = 55 + (50 - 55) * stress;
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function updatePreview() {
  if (inputMode === 'stress') {
    colorPreviewEl.style.backgroundColor = approxStressColor(Number(stressSliderEl.value));
  } else {
    colorPreviewEl.style.backgroundColor = colorPickerEl.value;
  }
}

stressSliderEl.addEventListener('input', () => {
  stressValueEl.textContent = Number(stressSliderEl.value).toFixed(2);
  updatePreview();
});

colorPickerEl.addEventListener('input', updatePreview);

modeStressBtn.addEventListener('click', () => setInputMode('stress'));
modeColorBtn.addEventListener('click', () => setInputMode('color'));

function startCountdown(startAt) {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const remain = startAt - Date.now();
    if (remain <= 0) {
      countdownEl.textContent = '전환 적용됨';
      clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }
    countdownEl.textContent = `전환까지 ${(remain / 1000).toFixed(1)}초`;
  }, 100);
}

function addHistory(entry) {
  history.unshift(entry);
  if (history.length > 10) history.length = 10;
  renderHistory();
}

function renderHistory() {
  historyBodyEl.innerHTML = '';
  history.forEach((entry) => {
    const tr = document.createElement('tr');
    const time = new Date(entry.time).toLocaleTimeString('ko-KR', { hour12: false });
    const swatch = entry.color
      ? `<span class="history-swatch" style="background:${entry.color}"></span>${entry.color}`
      : '-';
    tr.innerHTML = `
      <td>${time}</td>
      <td>${entry.stress !== null ? entry.stress.toFixed(2) : '-'}</td>
      <td>${swatch}</td>
      <td class="${entry.ok ? 'history-ok' : 'history-fail'}">${entry.ok ? 'OK' : 'FAIL'}</td>
    `;
    historyBodyEl.appendChild(tr);
  });
}

btnSend.addEventListener('click', async () => {
  const body = inputMode === 'stress'
    ? { stress: Number(stressSliderEl.value) }
    : { color: colorPickerEl.value };
  const stressForHistory = inputMode === 'stress' ? Number(stressSliderEl.value) : null;

  btnSend.disabled = true;
  try {
    const res = await fetch('/api/color-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    addHistory({ time: Date.now(), stress: stressForHistory, color: data.color || null, ok: !!data.ok });

    if (data.ok) {
      startCountdown(data.startAt);
    } else {
      countdownEl.textContent = `전송 실패: ${data.error || '알 수 없는 오류'}`;
    }
  } catch (err) {
    console.error('[HTTP] 컬러 전송 실패', err);
    addHistory({ time: Date.now(), stress: stressForHistory, color: null, ok: false });
    countdownEl.textContent = '전송 실패: 네트워크 오류';
  } finally {
    btnSend.disabled = false;
  }
});

updatePreview();
