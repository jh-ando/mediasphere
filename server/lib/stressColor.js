// 스트레스 지수(0.0~1.0)를 색상(#RRGGBB)으로 매핑하는 독립 모듈.
// baikal.ai 연동 시 이 모듈의 호출부(stressToColor)만 그대로 두고 입력단만 바뀌면 된다.
//
// 색상표가 아직 미정이라 HSL 보간으로 임시 구현했다. 디자인 확정 시
// 아래 CALM_HSL / TENSE_HSL 상수만 고치면 된다.

// stress=0.0 (차분함) 쪽 기준 색상
const CALM_HSL = { h: 200, s: 70, l: 55 }; // 차분한 파랑

// stress=1.0 (긴장) 쪽 기준 색상
const TENSE_HSL = { h: 0, s: 80, l: 50 }; // 긴장된 빨강

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 색상환에서 최단 경로로 hue를 보간한다. 단순 lerp(h1, h2, t)를 쓰면
// 200°(파랑)->0°(빨강)처럼 먼 쪽으로 돌 때 중간에 노랑/초록을 거쳐가 버린다
// (긴장도가 올라가는데 중간에 "안전해 보이는" 노랑/초록이 나오는 건 의미상 이상하다).
function lerpHue(h1, h2, t) {
  let diff = h2 - h1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (h1 + diff * t + 360) % 360;
}

// HSL(0~360, 0~100, 0~100) -> [r, g, b] (0~255)
function hslToRgb(h, s, l) {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sNorm * Math.min(lNorm, 1 - lNorm);
  const f = (n) => lNorm - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function toHex(n) {
  return n.toString(16).padStart(2, '0').toUpperCase();
}

// stress(0.0~1.0) -> "#RRGGBB". 범위를 벗어나면 clamp한다.
function stressToColor(stress) {
  const t = Math.max(0, Math.min(1, stress));
  const h = lerpHue(CALM_HSL.h, TENSE_HSL.h, t);
  const s = lerp(CALM_HSL.s, TENSE_HSL.s, t);
  const l = lerp(CALM_HSL.l, TENSE_HSL.l, t);
  const [r, g, b] = hslToRgb(h, s, l);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

module.exports = { stressToColor };
