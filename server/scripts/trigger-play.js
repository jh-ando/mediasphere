#!/usr/bin/env node
// docs/LGU_WebSocket_Playback_Signal_Protocol_simple.md 연동 테스트용.
// 외부 디스플레이 컨트롤 업체 시스템 역할을 흉내내서 PLAY_TRIGGER를 보내고
// 서버 응답(ACK/ERROR)을 확인한다. 실제 업체 시스템 구현 전에 서버 쪽
// WebSocket 핸들러가 제대로 동작하는지 검증하는 용도.
//
// 사용 예:
//   node scripts/trigger-play.js
//   node scripts/trigger-play.js ws://192.168.8.10:3000/playback-control
const WebSocket = require('ws');

const url = process.argv[2] || 'ws://localhost:3000/playback-control';
const TIMEOUT_MS = 5000;

console.log(`[연결 시도] ${url}`);
const ws = new WebSocket(url);

const timeout = setTimeout(() => {
  console.error(`[!] ${TIMEOUT_MS}ms 안에 응답이 없습니다 - 서버가 켜져 있는지, 경로가 맞는지 확인하세요.`);
  ws.terminate();
  process.exit(1);
}, TIMEOUT_MS);

ws.on('open', () => {
  console.log('[연결됨] PLAY_TRIGGER 전송');
  ws.send(JSON.stringify({ type: 'PLAY_TRIGGER' }));
});

ws.on('message', (data) => {
  clearTimeout(timeout);
  console.log('[응답 수신]', data.toString());
  ws.close();
});

ws.on('close', () => {
  console.log('[연결 종료]');
});

ws.on('error', (err) => {
  clearTimeout(timeout);
  console.error('[오류]', err.message);
  process.exit(1);
});
