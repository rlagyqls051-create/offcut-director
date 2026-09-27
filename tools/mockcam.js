'use strict';
/* mockcam.js — 가짜 Canon CCAPI + Sony Remote API 서버 (테스트용)
 *   node tools/mockcam.js [port]   (기본 8080)
 *
 * 카메라 없이 연동 로직 검증:
 *   - 브라우저 테스트: camType 선택 + camIp = 127.0.0.1 (CORS 헤더 포함됨)
 *   - 카메라 측 REC 시뮬레이션: GET /control?rec=on|off|file  (폴링이 감지해야 함)
 *   - 호출 로그: GET /calls
 */
const http = require('http');

const port = +process.argv[2] || 8080;
let recording = false;
let fileSeq = 0;
let lastFile = null; // canon stop 시 addedcontents에 반환할 파일명
let instaFile = null; // insta360 stopCapture fileUrls
const calls = [];

const basename = () => `C${String(1000 + ++fileSeq).slice(1)}.MP4`;

function reply(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(body);
}

http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.method === 'OPTIONS') return reply(res, 204, {});

    /* ---- 테스트 제어판 ---- */
    if (p === '/control') {
      const rec = u.searchParams.get('rec');
      if (rec === 'on') recording = true;
      if (rec === 'off' && recording) { recording = false; lastFile = basename(); }
      if (rec === 'file') lastFile = basename(); // 촬영 없이 파일만
      return reply(res, 200, { ok: true, recording, lastFile });
    }
    if (p === '/calls') return reply(res, 200, calls.slice(-50));

    calls.push({ t: Date.now(), m: req.method, path: p + (u.search || ''), body: body.slice(0, 200) });

    /* ---- Canon CCAPI ---- */
    if (p === '/ccapi/' || p === '/ccapi') {
      return reply(res, 200, { ver: ['ver100'] });
    }
    if (p.endsWith('/deviceinformation')) {
      return reply(res, 200, { productname: 'EOS Mock', serialnumber: '000000000001', firmwareversion: '1.0.0' });
    }
    if (p.endsWith('/shooting/control/moviemode')) {
      return reply(res, 200, {});
    }
    if (p.endsWith('/shooting/control/recbutton')) {
      const j = JSON.parse(body || '{}');
      if (j.action === 'start') { recording = true; }
      if (j.action === 'stop' && recording) { recording = false; lastFile = basename(); }
      return reply(res, 200, {});
    }
    if (p.endsWith('/devicestatus/battery')) {
      return reply(res, 200, { name: 'LP-E6NH', level: 'half', quality: 'good', position: 'battery' });
    }
    if (p.endsWith('/devicestatus/storage')) {
      return reply(res, 200, { storage: [{ name: 'sd', accesscapability: 'readwrite', maxsize: 128e9, spacesize: 42.3e9, contentsnumber: 17 }] });
    }
    if (p.endsWith('/devicestatus/temperature')) {
      return reply(res, 200, { status: 'normal' });
    }
    if (p.endsWith('/event/polling')) {
      const out = { recording, lastmodified: Date.now() };
      if (lastFile) { out.addedcontents = [`http://127.0.0.1:8080/ccapi/ver100/contents/sd/100CANON/${lastFile}`]; lastFile = null; }
      return reply(res, 200, out);
    }

    /* ---- Insta360 OSC ---- */
    if (p === '/osc/info') {
      return reply(res, 200, { model: 'Insta360 X4-Mock', serialNumber: 'X4M001', firmwareVersion: '1.2.3', supportUrls: [] });
    }
    if (p === '/osc/commands/execute') {
      const j = JSON.parse(body || '{}');
      if (j.name === 'camera.startCapture') { recording = true; return reply(res, 200, { name: j.name, state: 'done' }); }
      if (j.name === 'camera.stopCapture') {
        if (recording) { recording = false; instaFile = basename(); }
        return reply(res, 200, { name: j.name, state: 'done', results: { fileUrls: [`http://127.0.0.1/DCIM/Camera01/${instaFile || 'none'}`], _localFileUrls: [`/DCIM/Camera01/${instaFile || 'none'}`] } });
      }
      return reply(res, 200, { name: j.name, state: 'error', error: { code: 'unknownCommand' } });
    }
    if (p === '/osc/state') {
      return reply(res, 200, { fingerprint: 'fp1', state: { _captureStatus: recording, batteryLevel: '80%', remainingSpace: 20e9 } });
    }

    /* ---- Sony Camera Remote API (JSON-RPC) ---- */
    if (p === '/sony/camera') {
      const j = JSON.parse(body || '{}');
      const ok = result => reply(res, 200, { id: j.id, result });
      switch (j.method) {
        case 'getAvailableApiList':
          return ok([['getAvailableApiList', 'startRecMode', 'startMovieRec', 'stopMovieRec', 'getEvent', 'getSystemInformation']]);
        case 'getSystemInformation':
          return ok([{ model: 'ILCE-MOCK', serial: '1234567', firmwareVersion: '1.00' }]);
        case 'startRecMode':
          return ok([0]);
        case 'startMovieRec':
          recording = true; return ok([0]);
        case 'stopMovieRec':
          if (recording) { recording = false; lastFile = basename(); }
          return ok(['C0001.MP4']);
        case 'getEvent':
          return ok([{ cameraStatus: recording ? 'MovieRecording' : 'IDLE' },
                     { type: 'batteryInfo', batteryInfo: [{ batteryID: 1, batteryLevelPercent: '73%' }] }]);
        default:
          return reply(res, 200, { id: j.id, error: [1, 'unimplemented'] });
      }
    }

    reply(res, 404, { error: 'not found', path: p });
  });
}).listen(port, () => console.log(`mockcam: http://127.0.0.1:${port}  (Canon /ccapi/*, Sony /sony/camera, 제어판 /control?rec=on|off, /calls)`));
