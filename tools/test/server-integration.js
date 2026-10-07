// 서버 통합 테스트: 로컬 MQTT 브로커(aedes) + 실제 server.js + 가짜 폰 5대
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const WebSocket = require('ws');

const REPO = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(REPO, 'server');
const DIST = path.join(SERVER_DIR, 'distribute');
const BASE = 'http://127.0.0.1:3000';
const PHONES = [1, 2, 3, 4, 5];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, json };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ── 테스트용 배포 파일 생성 (server/distribute는 gitignore 대상)
if (fs.existsSync(DIST)) throw new Error('server/distribute가 이미 있음 - 덮어쓰지 않고 중단');
fs.mkdirSync(path.join(DIST, 'videos'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'configs'), { recursive: true });
const manifest = { devices: [] };
for (const id of PHONES) {
  const tile = `P${String(id).padStart(3, '0')}`;
  const buf = crypto.randomBytes(200 * 1024);
  fs.writeFileSync(path.join(DIST, 'videos', `${tile}.mp4`), buf);
  const checksum = `sha256:${sha256(buf)}`;
  manifest.devices.push({ deviceId: id, tileId: tile, checksum });
  fs.writeFileSync(path.join(DIST, 'configs', `${id}.json`), JSON.stringify({
    deviceId: id, serverIp: '127.0.0.1', videoPath: '/sdcard/mediasphere/videos', currentVideo: tile, checksum,
  }));
}
fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest));

// ── 브로커
const aedes = require('aedes')();
const broker = net.createServer(aedes.handle);

let serverProc;
let serverLog = '';
const phones = {};
let latestStatus = null;
let statusWs;

async function main() {
  await new Promise((r) => broker.listen(1883, r));

  serverProc = spawn(process.execPath, ['src/server.js'], { cwd: SERVER_DIR });
  serverProc.stdout.on('data', (d) => { serverLog += d; });
  serverProc.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${BASE}/`); break; } catch (e) { await sleep(200); }
  }

  statusWs = new WebSocket('ws://127.0.0.1:3000/');
  statusWs.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'STATUS_UPDATE') latestStatus = m;
  });

  // ── 가짜 폰
  for (const id of PHONES) {
    const p = { id, controls: [], configs: 0, client: mqtt.connect('mqtt://127.0.0.1:1883') };
    phones[id] = p;
    await new Promise((r) => p.client.on('connect', r));
    p.client.subscribe(['wall/control', `wall/device/${id}`], { qos: 1 });
    p.client.on('message', async (topic, payload, packet) => {
      if (topic === 'wall/control') {
        const m = JSON.parse(payload.toString());
        p.controls.push({ ...m, retain: packet.retain });
        return;
      }
      // wall/device/{id} - 서버 /clips에서 실제로 받아 체크섬 계산 후 보고
      p.configs += 1;
      const cfg = JSON.parse(payload.toString());
      const buf = await new Promise((resolve, reject) => {
        http.get(`${BASE}/clips/${cfg.currentVideo}.mp4`, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      await sleep(300);
      if (id === 3) {
        p.client.publish(`wall/error/${id}`, JSON.stringify({ type: 'ERROR', reason: 'CHECKSUM_MISMATCH', detail: 'test' }));
      } else {
        p.client.publish(`wall/ready/${id}`, JSON.stringify({ type: 'READY', checksum: `sha256:${sha256(buf)}` }));
      }
    });
    const beat = () => p.client.publish(`wall/status/${id}`, JSON.stringify({
      deviceId: id, status: 'online', versionCode: 99, batteryPct: 90, charging: true,
      ...(id === 2 ? { playerError: 'ERROR_CODE_DECODER_INIT_FAILED' } : {}),
      ...(id === 4 ? { rebootError: 'NOT_DEVICE_OWNER' } : {}),
    }));
    beat();
    p.beat = setInterval(beat, 2000);
    // 이전 배포 상태: 옛 영상 체크섬으로 정상 보고했던 폰
    p.client.publish(`wall/ready/${id}`, JSON.stringify({ type: 'READY', checksum: 'sha256:OLD' }));
  }

  await sleep(2500);

  // ── 1. 배포 전: 옛 체크섬은 새 manifest 기준 불일치(S1)
  check('S1: 옛 체크섬 폰은 불일치로 판정', latestStatus.fileStatus[1] === 'mismatch', `fileStatus[1]=${latestStatus.fileStatus[1]}`);
  check('S6: 불일치 사유 OLD_FILE', latestStatus.fileReason[1] === 'OLD_FILE', `fileReason[1]=${latestStatus.fileReason[1]}`);
  check('S4: heartbeat 재생오류가 STATUS_UPDATE에 실림', latestStatus.playerError[2] === 'ERROR_CODE_DECODER_INIT_FAILED', JSON.stringify(latestStatus.playerError));
  check('S4: 재생오류 없는 폰은 비어있음', latestStatus.playerError[1] === undefined);
  check('리뷰#3: heartbeat 재부팅 실패 사유가 STATUS_UPDATE에 실림', latestStatus.rebootError && latestStatus.rebootError[4] === 'NOT_DEVICE_OWNER' && latestStatus.rebootError[1] === undefined, JSON.stringify(latestStatus.rebootError));

  const play1 = await req('POST', '/api/play');
  check('배포 전 /api/play 허용', play1.status === 200, `status=${play1.status}`);

  // ── 2. 배포 시작
  const pub = await req('POST', '/api/distribute/publish');
  check('배포 발행 응답', pub.status === 200, JSON.stringify(pub.json));
  await sleep(200);
  check('S5: 배포 시작 시 재생 중이던 영상 STOP 발행', phones[1].controls.some((c) => c.type === 'STOP'));

  const play2 = await req('POST', '/api/play');
  check('S5: 배포 중 /api/play 거부(409)', play2.status === 409, `status=${play2.status} ${JSON.stringify(play2.json)}`);

  const trigger = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:3000/playback-control');
    ws.on('open', () => ws.send(JSON.stringify({ type: 'PLAY_TRIGGER' })));
    ws.on('message', (d) => { resolve(JSON.parse(d.toString())); ws.close(); });
  });
  check('S5: 배포 중 PLAY_TRIGGER 거부(ERROR)', trigger.type === 'ERROR', JSON.stringify(trigger));

  // 배포 진행 상태 관찰 (STATUS_UPDATE는 1초 주기)
  await sleep(1200);
  const deployTotal = latestStatus.deploy && latestStatus.deploy.total;
  check('S1: 배포 대상 = 온라인 폰 5대 전부(옛 체크섬)', deployTotal === 5, `deploy.total=${deployTotal}`);
  check('S5: 배포 중 STATUS_UPDATE.deploy 존재(대시보드 재생 버튼 비활성 근거)', Boolean(latestStatus.deploy));

  // 배포 완료(+ 10초 뒤 CHECK_UPDATE)까지 대기
  for (let i = 0; i < 40 && latestStatus.deploy; i += 1) await sleep(500);
  await sleep(1200);
  check('배포 완료 후 deploy 표시 해제', latestStatus.deploy === null);

  const cu = phones[1].controls.filter((c) => c.type === 'CHECK_UPDATE');
  check('S2: CHECK_UPDATE는 미완료 폰(3번)에만', cu.length === 1 && JSON.stringify(cu[0].targetDeviceIds) === '[3]', JSON.stringify(cu));

  const fs1 = latestStatus.fileStatus;
  check('S1: 새 파일 보고한 폰은 정상', [1, 2, 4, 5].every((id) => fs1[id] === 'ok'), JSON.stringify([1, 2, 3, 4, 5].map((id) => fs1[id])));
  check('S6: 실패 폰 사유 CHECKSUM_MISMATCH', fs1[3] === 'mismatch' && latestStatus.fileReason[3] === 'CHECKSUM_MISMATCH', `fileReason[3]=${latestStatus.fileReason[3]}`);
  check('config 발행은 폰당 1회', PHONES.every((id) => phones[id].configs === 1), JSON.stringify(PHONES.map((id) => phones[id].configs)));

  const play3 = await req('POST', '/api/play');
  check('S5: 배포 완료 후 /api/play 다시 허용', play3.status === 200, `status=${play3.status}`);

  // ── 3. 원격 재부팅
  const r400 = await req('POST', '/api/reboot-device', {});
  check('S3: 대상 없는 재부팅 거부(400)', r400.status === 400);
  const rBad = await req('POST', '/api/reboot-device', { targetDeviceIds: [0, 'x'] });
  check('S3: 잘못된 대상 재부팅 거부(400)', rBad.status === 400);
  const r200 = await req('POST', '/api/reboot-device', { targetDeviceIds: [2] });
  await sleep(300);
  const reboot = phones[2].controls.find((c) => c.type === 'REBOOT_DEVICE');
  check('S3: 재부팅 요청 성공(200) + 폰에 REBOOT_DEVICE 전달', r200.status === 200 && reboot && JSON.stringify(reboot.targetDeviceIds) === '[2]', JSON.stringify(reboot));

  // 새로 접속한 폰이 retain된 REBOOT_DEVICE를 받으면 재부팅 루프 - 받지 않아야 한다
  const late = mqtt.connect('mqtt://127.0.0.1:1883');
  await new Promise((r) => late.on('connect', r));
  const lateMsgs = [];
  late.on('message', (t, pl) => lateMsgs.push({ t, m: JSON.parse(pl.toString()) }));
  late.subscribe(['wall/control', 'wall/device/1'], { qos: 1 });
  await sleep(800);
  check('S3: REBOOT_DEVICE는 retain되지 않음(재접속 폰 재부팅 루프 없음)', !lateMsgs.some((x) => x.m.type === 'REBOOT_DEVICE'), JSON.stringify(lateMsgs.filter((x) => x.t === 'wall/control').map((x) => x.m.type)));
  check('retain된 config는 재접속 폰도 받음', lateMsgs.some((x) => x.t === 'wall/device/1'));
  late.end(true);
}

main()
  .catch((e) => { console.error('TEST ERROR', e); results.push({ name: 'exception', ok: false }); })
  .finally(async () => {
    Object.values(phones).forEach((p) => { clearInterval(p.beat); p.client.end(true); });
    if (statusWs) statusWs.close();
    if (serverProc) serverProc.kill();
    broker.close();
    aedes.close();
    await sleep(500);
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.writeFileSync(path.join(__dirname, 'server.log'), serverLog);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
