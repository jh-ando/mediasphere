// 가짜 폰 439대 heartbeat - 대시보드 발열/키오스크 해제/최근 재시작 화면 확인용.
// 같은 폴더에 STOP_SIM 파일을 만들면 끝난다(또는 Ctrl+C). 서버와 브로커(1883)가 떠 있어야 한다.
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const STOP = path.join(__dirname, 'STOP_SIM');
const OFF = new Set([57, 58, 312]);
const now = Date.now();
const EXIT = {
  87: { reason: 'SIGNALED', at: now - 9 * 60_000, before: { at: now - 9.5 * 60_000, thermalStatus: 3, batteryTemp: 47, cpuTemp: 71, skinTemp: 44 } },
  88: { reason: 'LOW_MEMORY', at: now - 12 * 60_000, before: { at: now - 12.4 * 60_000, thermalStatus: 2, batteryTemp: 45, cpuTemp: 66 } },
  203: { reason: 'CRASH', at: now - 95 * 60_000, detail: 'java.lang.IllegalStateException: test', before: { at: now - 96 * 60_000, thermalStatus: 0, batteryTemp: 36, cpuTemp: 48 } },
  311: { reason: 'DEVICE_REBOOT', at: now - 130 * 60_000, afterBoot: true, before: { at: now - 130 * 60_000, thermalStatus: 1, batteryTemp: 39 } },
  150: { reason: 'EXIT_SELF', at: now - 20 * 60_000, intentional: 'RESTART' },
};
fs.rmSync(STOP, { force: true });
const c = mqtt.connect('mqtt://127.0.0.1:1883');
// 모든 폰이 "정상 파일"로 보고할 체크섬 - 서버 manifest의 체크섬과 같아야 그리드가 정상으로 보인다.
// 인자로 주거나(node heartbeat-sim.js sha256:...), 없으면 server/distribute/manifest.json 첫 기기 값을 쓴다.
const MANIFEST = path.resolve(__dirname, '..', '..', 'server', 'distribute', 'manifest.json');
const CHECKSUM = process.argv[2]
  || (fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')).devices[0].checksum : 'sha256:unknown');
c.on('connect', () => {
  // 영상 파일 수신 보고 - #150만 옛 파일(불일치)
  for (let id = 1; id <= 439; id += 1) {
    if (OFF.has(id)) continue;
    c.publish(`wall/ready/${id}`, JSON.stringify({ checksum: id === 150 ? 'sha256:old' : CHECKSUM }), { qos: 1 });
  }
  const tick = () => {
    if (fs.existsSync(STOP)) { c.end(true); process.exit(0); }
    for (let id = 1; id <= 439; id += 1) {
      if (OFF.has(id)) continue;
      const msg = { deviceId: id, status: 'online', versionCode: 30, batteryPct: 85, charging: id !== 140,
        thermalStatus: 0, batteryTemp: 33 + (id % 5), cpuTemp: 45 + (id % 9), skinTemp: 31 + (id % 4), kiosk: true };
      if (id === 87) Object.assign(msg, { thermalStatus: 3, batteryTemp: 47, cpuTemp: 71, skinTemp: 44 });
      if (id === 88) Object.assign(msg, { thermalStatus: 2, batteryTemp: 46, cpuTemp: 66, skinTemp: 43 });
      if (id === 212) Object.assign(msg, { kiosk: false, kioskSince: now - 3 * 60_000, kioskReturnAt: now + 7 * 60_000 });
      if (id === 205) msg.playerError = 'ERROR_CODE_DECODER_INIT_FAILED';
      if (id === 300) Object.assign(msg, { batteryPct: 15 });
      if (id === 401 || id === 402) msg.versionCode = 29;
      if (EXIT[id]) msg.lastExit = EXIT[id];
      c.publish(`wall/status/${id}`, JSON.stringify(msg));
    }
  };
  tick();
  setInterval(tick, 3000);
});
