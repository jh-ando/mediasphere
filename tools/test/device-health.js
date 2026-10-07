// 기기 건강 상태(발열·키오스크 해제·최근 재시작) 서버 통합 테스트: 로컬 브로커 + 실제 server.js + 가짜 폰
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const WebSocket = require('ws');
const aedes = require('aedes')();

const REPO = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(REPO, 'server');
const DATA = path.join(SERVER_DIR, 'data');
const EVENTS = path.join(DATA, 'device-events.json');
const BACKUP = path.join(__dirname, 'htest_data_backup');
const BASE = 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, c, d = '') => { results.push(Boolean(c)); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`); };
const post = async (u) => { const r = await fetch(BASE + u, { method: 'POST' }); return { status: r.status, json: await r.json() }; };

let st = null; let srv; let ws; let phone; let serverLog = '';
async function startServer() {
  srv = spawn(process.execPath, ['src/server.js'], { cwd: SERVER_DIR });
  srv.stdout.on('data', (d) => { serverLog += d; }); srv.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50; i += 1) { try { await fetch(`${BASE}/`); break; } catch (e) { await sleep(200); } }
  st = null;
  ws = new WebSocket('ws://127.0.0.1:3000/');
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'STATUS_UPDATE') st = m; });
  for (let i = 0; i < 20 && !st; i += 1) await sleep(250);
}
async function stopServer() { ws.close(); srv.kill(); await sleep(800); }
async function fresh() { const b = st; for (let i = 0; i < 12 && st === b; i += 1) await sleep(250); }
function hb(id, extra) {
  phone.publish(`wall/status/${id}`, JSON.stringify({ deviceId: id, status: 'online', versionCode: 30, batteryPct: 80, charging: true, ...extra }));
}

(async () => {
  let broker;
  try {
    if (fs.existsSync(EVENTS)) throw new Error('data/device-events.json이 이미 있음 - 중단');
    fs.rmSync(BACKUP, { recursive: true, force: true });
    fs.cpSync(DATA, BACKUP, { recursive: true });
    broker = net.createServer(aedes.handle); await new Promise((r) => broker.listen(1883, r));
    await startServer();
    phone = mqtt.connect('mqtt://127.0.0.1:1883'); await new Promise((r) => phone.on('connect', r));

    const now = Date.now();
    const before = { at: now - 60_000, thermalStatus: 3, batteryTemp: 47, cpuTemp: 71.2, skinTemp: 44 };
    // 1번: 정상 온도 / 2번: 발열 단계 심각 / 3번: 배터리 46°C(단계는 보통) / 4번: 키오스크 해제
    // 5번: 발열로 죽었다 다시 켜짐(SIGNALED) / 6번: 원격 재시작(의도) / 7번: 구버전 앱(새 필드 없음)
    const send = () => {
      hb(1, { thermalStatus: 0, batteryTemp: 33.5, cpuTemp: 48, skinTemp: 31 });
      hb(2, { thermalStatus: 3, batteryTemp: 41 });
      hb(3, { thermalStatus: 2, batteryTemp: 46.1 });
      hb(4, { thermalStatus: 1, batteryTemp: 36, kiosk: false, kioskSince: now - 180_000, kioskReturnAt: now + 420_000 });
      hb(5, { thermalStatus: 1, batteryTemp: 39, lastExit: { reason: 'SIGNALED', at: now - 30_000, afterBoot: false, before } });
      hb(6, { thermalStatus: 0, batteryTemp: 35, lastExit: { reason: 'EXIT_SELF', at: now - 20_000, intentional: 'RESTART' } });
      hb(7, {});
    };
    send(); await sleep(300); send(); // 같은 lastExit가 두 번 와도 기록은 한 번
    await fresh(); await fresh();

    check('온도 저장(1번 정상값)', st.thermal['1'] && st.thermal['1'].b === 33.5 && st.thermal['1'].c === 48 && st.thermal['1'].s === 0, JSON.stringify(st.thermal['1']));
    check('발열 판정 = 2번(단계 심각), 3번(배터리 45°C 이상)만', JSON.stringify(st.hot) === '[2,3]', JSON.stringify(st.hot));
    check('키오스크 해제 = 4번(해제·복귀 시각 포함)', Object.keys(st.kiosk).join() === '4' && st.kiosk['4'].returnAt === now + 420_000, JSON.stringify(st.kiosk));
    check('최근 재시작 = 5번만(의도한 6번 제외)', Object.keys(st.restarts).join() === '5', JSON.stringify(Object.keys(st.restarts)));
    check('재시작 사유·직전 온도', st.restarts['5'].count === 1 && st.restarts['5'].last.reason === 'SIGNALED' && st.restarts['5'].last.before.b === 47 && st.restarts['5'].last.before.s === 3,
      JSON.stringify(st.restarts['5']));
    check('구버전 앱(7번)은 새 항목 없이 정상', st.devices['7'] === 'online' && !st.thermal['7'] && !st.kiosk['7']);
    const saved = JSON.parse(fs.readFileSync(EVENTS, 'utf-8'));
    check('종료 기록 파일 저장(중복 없이 2건: 5번·6번)', saved.events.length === 2 && saved.events.some((e) => e.deviceId === '6' && e.intentional === 'RESTART'), `${saved.events.length}건`);

    // 키오스크 다시 잠김 → 해제 목록에서 빠짐
    hb(4, { thermalStatus: 1, batteryTemp: 36, kiosk: true }); await fresh(); await fresh();
    check('키오스크 다시 잠기면 목록에서 빠짐', !st.kiosk['4'], JSON.stringify(st.kiosk));

    // 같은 폰이 또 죽음 → 횟수 2, 마지막 사유 갱신
    hb(5, { thermalStatus: 4, batteryTemp: 50, lastExit: { reason: 'LOW_MEMORY', at: now - 5_000, afterBoot: false } });
    await fresh(); await fresh();
    check('같은 폰 재발 → 횟수 2, 마지막 = 메모리 부족', st.restarts['5'].count === 2 && st.restarts['5'].last.reason === 'LOW_MEMORY', JSON.stringify(st.restarts['5']));

    // 이력 조회
    const ev = await (await fetch(`${BASE}/api/device-events?deviceId=5`)).json();
    check('이력 조회 API(최신순 2건)', ev.ok && ev.events.length === 2 && ev.events[0].reason === 'LOW_MEMORY');
    const bad = await fetch(`${BASE}/api/device-events?deviceId=abc`);
    check('이력 조회 잘못된 번호 400', bad.status === 400);

    // 끊긴 폰도 마지막 온도는 남음
    await sleep(11_000); await fresh();
    check('끊긴 폰: 발열·키오스크 알림에서 빠지고 마지막 온도는 유지', st.devices['2'] === 'offline' && st.hot.length === 0 && st.thermal['2'] && st.thermal['2'].s === 3, JSON.stringify(st.hot));

    // 서버 재시작 → 기록 유지, 같은 lastExit 다시 와도 중복 안 됨
    await stopServer(); await startServer();
    hb(5, { thermalStatus: 1, batteryTemp: 39, lastExit: { reason: 'LOW_MEMORY', at: now - 5_000, afterBoot: false } });
    await fresh(); await fresh();
    check('서버 재시작 후 최근 재시작 유지 + 중복 없음', st.restarts['5'] && st.restarts['5'].count === 2, JSON.stringify(st.restarts['5']));

    // [확인] → 목록 비움, 이후 새 종료만 다시 나옴
    const ack = await post('/api/restarts/ack');
    await fresh(); await fresh();
    check('[확인] 후 최근 재시작 비움', ack.status === 200 && Object.keys(st.restarts).length === 0, JSON.stringify(st.restarts));
    hb(1, { thermalStatus: 0, batteryTemp: 34, lastExit: { reason: 'ANR', at: Date.now() - 1000, afterBoot: false } });
    await fresh(); await fresh();
    check('[확인] 이후 새로 생긴 재시작은 다시 표시', Object.keys(st.restarts).join() === '1' && st.restarts['1'].last.reason === 'ANR', JSON.stringify(Object.keys(st.restarts)));
    const saved2 = JSON.parse(fs.readFileSync(EVENTS, 'utf-8'));
    check('[확인] 시각도 파일에 저장', saved2.ackAt > 0 && saved2.events.length === 4, `${saved2.events.length}건`);
  } catch (e) {
    console.error('TEST ERROR', e); results.push(false);
  } finally {
    if (phone) phone.end(true);
    if (ws) ws.close(); if (srv) srv.kill();
    if (broker) broker.close(); aedes.close();
    await sleep(800);
    fs.writeFileSync(path.join(__dirname, 'htest_server.log'), serverLog);
    // 설정 복원 - 테스트가 만든 device-events.json은 지운다
    fs.rmSync(EVENTS, { force: true });
    if (fs.existsSync(BACKUP)) for (const f of fs.readdirSync(BACKUP)) fs.copyFileSync(path.join(BACKUP, f), path.join(DATA, f));
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
