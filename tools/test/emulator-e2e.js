// 에뮬레이터 실기 흐름 테스트: 로컬 브로커(aedes) + 실제 server.js + 에뮬레이터의 실제 APK
// 전제: 에뮬레이터가 부팅돼 있고 adb로 보인다. 앱은 이 스크립트가 설치/설정한다.
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const mqtt = require('mqtt');
const WebSocket = require('ws');
const aedes = require('aedes')();

const REPO = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(REPO, 'server');
const DIST = path.join(SERVER_DIR, 'distribute');
const APK = path.join(REPO, 'android/app/build/outputs/apk/debug/app-debug.apk');
const ADB = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const CLIPS = path.join(__dirname, 'clips');
const PKG = 'com.mediasphere.client';
const BASE = 'http://127.0.0.1:3000';
const DEVICE_VIDEO = '/sdcard/mediasphere/videos/P001.mp4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf-8' }).trim();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const deviceSha = () => {
  try { return adb('shell', `sha256sum ${DEVICE_VIDEO}`).split(/\s+/)[0]; } catch (e) { return null; }
};
const deviceTempFiles = () => adb('shell', 'ls /sdcard/mediasphere/videos/').split(/\s+/).filter((f) => f.endsWith('.download'));

// ── logcat 수집
const logLines = [];
let logcat;
function startLogcat() {
  adb('logcat', '-c');
  logcat = spawn(ADB, ['logcat', '-v', 'time']);
  let buf = '';
  logcat.stdout.on('data', (d) => {
    buf += d.toString('utf-8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    for (const l of parts) if (/\[(FileSync|Player|MQTT|RestartBridge|Boot)\]|AndroidRuntime|FATAL/.test(l)) logLines.push(l);
  });
}
const mark = () => logLines.length;
const logsSince = (m, re) => logLines.slice(m).filter((l) => re.test(l));

// ── 배포 파일 (server/distribute는 gitignore 대상)
let mqttPub;
function setServerFile(clip, manifestChecksumOf = clip) {
  fs.copyFileSync(path.join(CLIPS, clip), path.join(DIST, 'videos', 'P001.mp4'));
  const checksum = `sha256:${sha(path.join(CLIPS, manifestChecksumOf))}`;
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify({ devices: [{ deviceId: 1, tileId: 'P001', checksum }] }));
  const cfg = { deviceId: 1, serverIp: '10.0.2.2', mqttBroker: 'tcp://10.0.2.2:1883', videoPath: '/sdcard/mediasphere/videos', currentVideo: 'P001', checksum };
  fs.writeFileSync(path.join(DIST, 'configs', '1.json'), JSON.stringify(cfg));
  return cfg;
}
async function req(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { /* */ }
  return { status: res.status, json };
}
let latestStatus = null;
async function waitFor(desc, fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return Date.now() - start;
    await sleep(300);
  }
  console.log(`  (timeout waiting: ${desc})`);
  return null;
}
const fileOk = () => latestStatus && latestStatus.fileStatus[1] === 'ok';
const appPid = () => { try { return adb('shell', `pidof ${PKG}`); } catch (e) { return ''; } };

let serverProc; let serverLog = ''; let broker; let statusWs;

async function startServer() {
  serverProc = spawn(process.execPath, ['src/server.js'], { cwd: SERVER_DIR });
  serverProc.stdout.on('data', (d) => { serverLog += d; });
  serverProc.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50; i += 1) { try { await fetch(`${BASE}/`); break; } catch (e) { await sleep(200); } }
  statusWs = new WebSocket('ws://127.0.0.1:3000/');
  statusWs.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'STATUS_UPDATE') latestStatus = m; });
}

async function main() {
  if (fs.existsSync(DIST)) throw new Error('server/distribute가 이미 있음 - 중단');
  fs.mkdirSync(path.join(DIST, 'videos'), { recursive: true });
  fs.mkdirSync(path.join(DIST, 'configs'), { recursive: true });
  const cfg1 = setServerFile('v1.mp4');

  broker = net.createServer(aedes.handle);
  await new Promise((r) => broker.listen(1883, r));
  await startServer();
  mqttPub = mqtt.connect('mqtt://127.0.0.1:1883');
  await new Promise((r) => mqttPub.on('connect', r));

  // ── 폰 준비: 설치, Device Owner, 저장소 권한, config.json
  console.log('[setup] APK 설치 및 설정');
  adb('install', '-r', '-g', APK);
  try { console.log('  ', adb('shell', `dpm set-device-owner --user 0 ${PKG}/.DeviceAdminReceiver`)); } catch (e) { console.log('  device owner:', e.message.split('\n')[0]); }
  adb('shell', `appops set --uid ${PKG} MANAGE_EXTERNAL_STORAGE allow`);
  adb('shell', 'rm -rf /sdcard/mediasphere && mkdir -p /sdcard/mediasphere/videos');
  const localCfg = path.join(__dirname, 'config.json');
  fs.writeFileSync(localCfg, JSON.stringify({ deviceId: 1, serverIp: '10.0.2.2', mqttBroker: 'tcp://10.0.2.2:1883', videoPath: cfg1.videoPath, currentVideo: 'P001' }));
  adb('push', localCfg, '/sdcard/mediasphere/config.json');
  adb('emu', 'network', 'speed', '8000');
  startLogcat();
  adb('shell', `am start -n ${PKG}/.MainActivity`);

  // ── A. 첫 동기화(파일 없음 → 받기 → 교체 → 로드)
  await waitFor('online', () => latestStatus && latestStatus.devices[1] === 'online', 60000);
  await req('POST', '/api/distribute/publish');
  const tA = await waitFor('A ok', fileOk, 90000);
  check('A: 첫 배포 - 다운로드/검증 후 정상 보고', tA !== null, `${tA}ms`);
  check('A: 폰 파일 = v1', deviceSha() === sha(path.join(CLIPS, 'v1.mp4')));
  check('A: 임시 파일 안 남음', deviceTempFiles().length === 0, deviceTempFiles().join(','));
  // 시작 직후엔 파일이 없어 FILE_NOT_FOUND가 나는 게 정상 - 로드 후 다음 heartbeat(5초 주기)에서 지워져야 한다
  const tAc = await waitFor('A playerError cleared', () => !(latestStatus.playerError || {})[1], 12000);
  check('A: 정상 파일 로드 후 재생오류 해제', tAc !== null, JSON.stringify(latestStatus.playerError));

  // ── B. 배포 중엔 재생 거부, 배포 창(완료 후 CHECK_UPDATE까지)이 닫히면 재생
  const playDuring = await req('POST', '/api/play');
  check('B: 배포 창이 열려 있는 동안 재생 거부(409)', playDuring.status === 409, `status=${playDuring.status}`);
  await waitFor('deploy closed', () => latestStatus && latestStatus.deploy === null, 30000);
  const play = await req('POST', '/api/play');
  await sleep(2500);
  check('B: 배포 창이 닫힌 뒤 재생 시작', play.status === 200 && logsSince(0, /재생 시작/).length > 0, `status=${play.status}`);
  await waitFor('deploy closed', () => latestStatus && latestStatus.deploy === null, 30000);

  // ── C. 같은 파일명 재배포(v2, 느린 다운로드) 중 CHECK_UPDATE/retain 재수신 → 무시되고 재로드 1번
  let m = mark();
  const cfg2 = setServerFile('v2.mp4');
  const t0 = Date.now();
  await req('POST', '/api/distribute/publish');
  await sleep(3000);
  mqttPub.publish('wall/control', JSON.stringify({ type: 'CHECK_UPDATE', targetDeviceIds: [1] }), { qos: 1 });
  await sleep(1000);
  mqttPub.publish('wall/device/1', JSON.stringify(cfg2), { qos: 1, retain: true });
  const stillDownloading = logsSince(m, /재생 파일 로드/).length === 0;
  const tC = await waitFor('C ok', () => fileOk() && deviceSha() === sha(path.join(CLIPS, 'v2.mp4')), 120000);
  await sleep(1500);
  check('C: 다운로드 중 중복 요청은 무시', stillDownloading && logsSince(m, /요청 무시/).length >= 2, `${logsSince(m, /요청 무시/).length}건, 중복 요청 시점에 아직 다운로드 중=${stillDownloading}`);
  check('C: 재생 파일 로드는 1번', logsSince(m, /재생 파일 로드/).length === 1, `${logsSince(m, /재생 파일 로드/).length}번, 배포~완료 ${tC !== null ? Date.now() - t0 : '?'}ms`);
  check('C: 폰 파일 = v2, 임시 파일 없음', deviceSha() === sha(path.join(CLIPS, 'v2.mp4')) && deviceTempFiles().length === 0);

  // ── D. 서버 파일과 manifest 체크섬 불일치 → 교체 안 함, CHECKSUM_MISMATCH 보고, 기존 파일 유지
  m = mark();
  setServerFile('v3.mp4', 'v5.mp4');
  await req('POST', '/api/distribute/publish');
  const tD = await waitFor('D reason', () => latestStatus && (latestStatus.fileReason || {})[1] === 'CHECKSUM_MISMATCH', 90000);
  check('D: CHECKSUM_MISMATCH 보고', tD !== null);
  check('D: 불일치로 2번만 받고 포기', logsSince(m, /받은 파일 체크섬 불일치/).length === 2, `${logsSince(m, /받은 파일 체크섬 불일치/).length}번`);
  check('D: 재생 파일 교체/재로드 안 함(v2 유지)', logsSince(m, /재생 파일 로드/).length === 0 && deviceSha() === sha(path.join(CLIPS, 'v2.mp4')));
  check('D: 임시 파일 없음', deviceTempFiles().length === 0, deviceTempFiles().join(','));

  // ── E. 다운로드 도중 다른 파일로 다시 배포 → 이전 다운로드 즉시 취소, 최종 v5 하나만 로드
  m = mark();
  setServerFile('v4.mp4');
  await req('POST', '/api/distribute/publish');
  await sleep(4000);
  const v4StillDownloading = logsSince(m, /재생 파일 로드/).length === 0;
  setServerFile('v5.mp4');
  const tE0 = Date.now();
  await req('POST', '/api/distribute/publish');
  const tE = await waitFor('E ok', () => fileOk() && deviceSha() === sha(path.join(CLIPS, 'v5.mp4')), 90000);
  await sleep(1500);
  check('E: 다른 파일 재배포 시 이전 다운로드 취소 후 최신 파일만 로드', v4StillDownloading && tE !== null && logsSince(m, /재생 파일 로드/).length === 1, `로드 ${logsSince(m, /재생 파일 로드/).length}번, 재배포~완료 ${tE}ms, 재배포 시점에 v4 다운로드 중=${v4StillDownloading}`);
  check('E: 임시 파일 없음', deviceTempFiles().length === 0, deviceTempFiles().join(','));

  // ── F. 재생 불가 파일 → 재생오류 보고 → 정상 파일 배포로 해제
  m = mark();
  setServerFile('garbage.mp4');
  await req('POST', '/api/distribute/publish');
  const tF = await waitFor('F playerError', () => latestStatus && (latestStatus.playerError || {})[1], 60000);
  check('F: 재생오류가 heartbeat로 대시보드까지 보고됨', tF !== null, JSON.stringify(latestStatus.playerError));
  check('F: 재생 오류 복구 시도(재검증 후 재로드)', logsSince(m, /재생 오류 복구 시도/).length >= 1);
  setServerFile('v1.mp4');
  await req('POST', '/api/distribute/publish');
  const tF2 = await waitFor('F cleared', () => fileOk() && latestStatus && !(latestStatus.playerError || {})[1], 60000);
  check('F: 정상 파일 배포 후 재생오류 해제', tF2 !== null);
  check('F: 크래시 없음', logsSince(0, /FATAL|AndroidRuntime/).length === 0, logsSince(0, /FATAL/).join(' | '));

  // ── G. 앱 재시작(RESTART_APP)
  const pidBefore = appPid();
  await req('POST', '/api/restart-app', { targetDeviceIds: [1] });
  const tG = await waitFor('G new pid', () => { const p = appPid(); return p && p !== pidBefore; }, 30000);
  check('G: 앱 재시작 후 새 프로세스로 복귀', tG !== null, `pid ${pidBefore} -> ${appPid()}`);
  const tG2 = await waitFor('G online', () => latestStatus && latestStatus.devices[1] === 'online', 30000);
  check('G: 재시작 후 다시 온라인', tG2 !== null);

  // ── H. 원격 재부팅(REBOOT_DEVICE)
  await sleep(6000); // 재시작 직후 MQTT 재구독이 끝날 여유
  const hMark = mark();
  await req('POST', '/api/reboot-device', { targetDeviceIds: [1] });
  await sleep(3000);
  console.log('  H logs:', logsSince(hMark, /REBOOT|재부팅/).join(' | ') || '(없음)');
  logcat.kill();
  const offline = await waitFor('H offline', () => latestStatus && latestStatus.devices[1] === 'offline', 60000);
  check('H: 재부팅 명령으로 기기가 꺼짐(오프라인)', offline !== null, `rebootError=${JSON.stringify(latestStatus.rebootError)}`);
  execFileSync(ADB, ['wait-for-device'], { timeout: 180000 });
  await waitFor('boot', () => { try { return adb('shell', 'getprop sys.boot_completed') === '1'; } catch (e) { return false; } }, 180000);
  const back = await waitFor('H online', () => latestStatus && latestStatus.devices[1] === 'online', 120000);
  check('H: 재부팅 후 앱 자동 실행 + 다시 온라인', back !== null, `pid=${appPid()}`);
}

main()
  .catch((e) => { console.error('TEST ERROR', e); results.push({ name: 'exception', ok: false }); })
  .finally(async () => {
    try { adb('emu', 'network', 'speed', 'full'); } catch (e) { /* */ }
    if (logcat) logcat.kill();
    if (mqttPub) mqttPub.end(true);
    if (statusWs) statusWs.close();
    if (serverProc) serverProc.kill();
    if (broker) broker.close();
    aedes.close();
    await sleep(500);
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.writeFileSync(path.join(__dirname, 'server.log'), serverLog);
    fs.writeFileSync(path.join(__dirname, 'logcat.log'), logLines.join('\n'));
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
