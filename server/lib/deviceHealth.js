// MediaSphere - 기기 건강 상태 (발열·키오스크 해제·앱 종료 기록)
//
// 폰 heartbeat(wall/status/{id})에 실려오는 온도, 현장 정비(키오스크 해제) 상태, 지난번 앱
// 종료 정보(lastExit)를 모아 대시보드 "발열"/"키오스크 해제"/"최근 재시작" 표시에 쓴다.
// 앱이 죽으면 그동안은 보고를 못 하므로, 폰은 다시 켜졌을 때 "왜 죽었는지 + 죽기 직전 온도"를
// lastExit로 다음 종료 전까지 계속 싣는다 - 여기서 at(종료 시각)으로 중복을 거르고 파일에 남긴다.
'use strict';

const fs = require('fs');
const path = require('path');

// "발열" 알림 기준 - 발열 단계 "심각"(3) 이상이거나 배터리 45°C 이상. 현장 데이터 보고 조정.
const HEAT_STATUS_MIN = 3;
const HEAT_BATTERY_TEMP_MIN = 45;
// "최근 재시작"으로 보여주는 기간과 종료 기록 보관 기간/최대 개수
const RESTART_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_MAX = 5000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function isHot(t) {
  return t.s >= HEAT_STATUS_MIN || (t.b !== null && t.b >= HEAT_BATTERY_TEMP_MIN);
}

function createDeviceHealth(filePath) {
  // deviceId(문자열) -> 마지막으로 보고된 온도 { s: 발열 단계, b: 배터리, c: CPU, k: 표면, at }.
  // 오프라인이 돼도 지우지 않는다 - 대시보드 툴팁에 "끊기기 직전 상태"로 보여준다.
  const thermal = {};
  // deviceId -> { since, returnAt } - 현장 정비 메뉴로 키오스크가 풀린 폰
  const kiosk = {};
  // 파일에 남기는 것: ackAt(대시보드 [확인]을 누른 시각) + 종료 기록 목록
  let store = { ackAt: 0, events: [] };
  // deviceId -> 이미 기록한 마지막 종료 시각 - heartbeat마다 같은 lastExit가 오므로 중복 제거용
  const lastExitAt = {};

  function load() {
    if (!fs.existsSync(filePath)) return;
    try {
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      store = {
        ackAt: num(loaded.ackAt) || 0,
        events: Array.isArray(loaded.events) ? loaded.events : [],
      };
      store.events.forEach((e) => {
        if (!(lastExitAt[e.deviceId] >= e.at)) lastExitAt[e.deviceId] = e.at;
      });
    } catch (err) {
      console.error('[HTTP] device-events.json 읽기 실패 - 빈 기록으로 시작:', err.message);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(store, null, 1));
    } catch (err) {
      console.error('[HTTP] device-events.json 저장 실패:', err.message);
    }
  }

  function prune(now) {
    store.events = store.events.filter((e) => now - e.receivedAt < EVENT_KEEP_MS);
    if (store.events.length > EVENT_MAX) store.events = store.events.slice(-EVENT_MAX);
  }

  // heartbeat 한 건 반영. 구버전 앱은 새 필드가 없을 뿐이라 그대로 무시된다.
  function onHeartbeat(deviceId, msg, now) {
    const id = String(deviceId);
    if (typeof msg.thermalStatus === 'number') {
      thermal[id] = {
        s: msg.thermalStatus, b: num(msg.batteryTemp), c: num(msg.cpuTemp), k: num(msg.skinTemp), at: now,
      };
    }
    if (msg.kiosk === false) {
      kiosk[id] = { since: num(msg.kioskSince), returnAt: num(msg.kioskReturnAt) };
    } else {
      delete kiosk[id];
    }
    const exit = msg.lastExit;
    if (exit && typeof exit.reason === 'string' && typeof exit.at === 'number'
      && !(lastExitAt[id] >= exit.at)) {
      lastExitAt[id] = exit.at;
      store.events.push({
        deviceId: id,
        reason: exit.reason,
        at: exit.at,
        detail: typeof exit.detail === 'string' ? exit.detail.slice(0, 200) : null,
        afterBoot: exit.afterBoot === true,
        intentional: typeof exit.intentional === 'string' ? exit.intentional : null,
        before: exit.before && typeof exit.before === 'object' ? {
          s: num(exit.before.thermalStatus), b: num(exit.before.batteryTemp),
          c: num(exit.before.cpuTemp), k: num(exit.before.skinTemp), at: num(exit.before.at),
        } : null,
        receivedAt: now,
      });
      prune(now);
      save();
      console.log(`[MQTT] 앱 종료 기록 - device ${id} ${exit.reason}${exit.intentional ? `(의도: ${exit.intentional})` : ''} at=${new Date(exit.at).toISOString()}`);
    }
  }

  // 대시보드 STATUS_UPDATE에 실을 부분. 발열/키오스크 해제는 지금 연결된 폰만, 온도는 끊긴 폰도
  // 마지막 값을 싣는다. "최근 재시작"은 의도하지 않은 종료 중 24시간 안 + [확인] 이후 것만.
  function buildPayload(isOnline, now) {
    const hot = [];
    const kioskOnline = {};
    Object.keys(thermal).forEach((id) => { if (isOnline(id) && isHot(thermal[id])) hot.push(Number(id)); });
    Object.keys(kiosk).forEach((id) => { if (isOnline(id)) kioskOnline[id] = kiosk[id]; });

    const since = Math.max(store.ackAt, now - RESTART_WINDOW_MS);
    const restarts = {};
    store.events.forEach((e) => {
      if (e.intentional || e.at <= since) return;
      const r = restarts[e.deviceId] || (restarts[e.deviceId] = { count: 0, last: null });
      r.count += 1;
      if (!r.last || e.at > r.last.at) {
        r.last = { reason: e.reason, at: e.at, detail: e.detail, afterBoot: e.afterBoot, before: e.before };
      }
    });
    return {
      thermal, hot: hot.sort((a, b) => a - b), kiosk: kioskOnline, restarts, restartAckAt: store.ackAt,
    };
  }

  // 대시보드 [확인] - 지금까지의 재시작은 "최근 재시작"에서 뺀다(기록 자체는 남김).
  function ack(now) {
    store.ackAt = now;
    save();
  }

  // 한 폰의 종료 기록(의도한 것 포함) - 최신순
  function eventsFor(deviceId, limit = 100) {
    const id = String(deviceId);
    return store.events.filter((e) => e.deviceId === id).sort((a, b) => b.at - a.at).slice(0, limit);
  }

  load();
  return { onHeartbeat, buildPayload, ack, eventsFor };
}

module.exports = { createDeviceHealth, HEAT_STATUS_MIN, HEAT_BATTERY_TEMP_MIN, RESTART_WINDOW_MS };
