'use strict';
/* testcam.js — CamLink 어댑터 헤드리스 테스트 (mockcam 서버 필요)
 *   터미널1: node tools/mockcam.js        (포트 8080)
 *   터미널2: node tools/testcam.js
 */
const fs = require('fs');
const path = require('path');
globalThis.window = {}; // Capacitor 없음 → fetch 경로 사용
eval(fs.readFileSync(path.join(__dirname, '..', 'www', 'camera.js'), 'utf8') + '\n;globalThis.__CamLink = CamLink;');
const Cam = globalThis.__CamLink;

const BASE = 'http://127.0.0.1:8080';
const cfg = t => ({ type: t, ip: '127.0.0.1' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`); };

(async () => {
  /* ---------- Canon ---------- */
  const canon = cfg('canon');
  check('canon isLinked', Cam.isLinked(canon));
  const who = await Cam.test(canon);
  check('canon test → 모델명', /EOS Mock/.test(who));

  await Cam.recStart(canon);
  let st = await fetch(`${BASE}/calls`).then(r => r.json());
  check('canon moviemode 호출됨', st.some(c => c.path.includes('moviemode')));
  check('canon recbutton start 호출됨', st.some(c => c.path.includes('recbutton') && c.body.includes('start')));

  let s = await fetch(`${BASE}/control?rec=query`).then(r => r.json()).catch(() => ({}));
  check('canon 녹화 상태 on (모크 내부)', s.recording === true);

  await Cam.recStop(canon);
  st = await fetch(`${BASE}/calls`).then(r => r.json());
  check('canon recbutton stop 호출됨', st.some(c => c.path.includes('recbutton') && c.body.includes('stop')));

  /* ---------- 폴링: 카메라 측 REC 자동 감지 ---------- */
  const events = [];
  Cam.startPoll(canon, ev => events.push(ev), 250);
  await sleep(400);
  await fetch(`${BASE}/control?rec=on`);   // 카메라에서 REC 누른 상황 시뮬레이션
  await sleep(500);
  check('poll: 외부 REC 시작 감지', events.some(e => e.type === 'state' && e.recording === true));
  await fetch(`${BASE}/control?rec=off`);  // 카메라에서 정지
  await sleep(500);
  check('poll: 외부 REC 정지 감지', events.some(e => e.type === 'state' && e.recording === false));
  check('poll: addedcontents → 진짜 파일명 수신', events.some(e => e.type === 'file' && /^C\d+\.MP4$/.test(e.name)));
  Cam.stopPoll();

  /* ---------- Sony ---------- */
  const sony = cfg('sony');
  const swho = await Cam.test(sony).catch(() => null);
  check('sony test → API 목록', !!swho);
  await Cam.recStart(sony);
  st = await fetch(`${BASE}/calls`).then(r => r.json());
  check('sony startRecMode+startMovieRec', st.some(c => c.body.includes('startMovieRec')));
  const sevents = [];
  Cam.startPoll(sony, ev => sevents.push(ev), 250);
  await sleep(400);
  check('sony poll: MovieRecording 감지', sevents.some(e => e.type === 'state' && e.recording === true));
  await Cam.recStop(sony);
  await sleep(500);
  check('sony poll: 정지 감지', sevents.some(e => e.type === 'state' && e.recording === false));
  Cam.stopPoll();

  /* ---------- Insta360 OSC (실기는 포트80 — 테스트는 ip에 포트 포함) ---------- */
  const i360 = { type: 'insta360', ip: '127.0.0.1:8080' };
  check('insta360 isLinked', Cam.isLinked(i360));
  const iwho = await Cam.test(i360);
  check('insta360 test → 모델명', /Insta360 X4-Mock/.test(iwho));
  await Cam.recStart(i360);
  st = await fetch(`${BASE}/calls`).then(r => r.json());
  check('insta360 startCapture 발송', st.some(c => c.path.includes('/osc/commands/execute') && c.body.includes('startCapture')));
  const ievents = [];
  Cam.startPoll(i360, ev => ievents.push(ev), 250);
  await sleep(400);
  check('insta360 poll: _captureStatus 감지', ievents.some(e => e.type === 'state' && e.recording === true));
  await Cam.recStop(i360); // fileUrls 포함 응답
  await sleep(500);
  check('insta360 poll: 정지 + fileUrls 파일명 수신', ievents.some(e => e.type === 'file' && /\.MP4$/i.test(e.name)));
  Cam.stopPoll();
  const ii = await Cam.getInfo(i360);
  check('insta360 getInfo 모델/배터리', /X4-Mock/.test(ii.model || '') && !!ii.battery, JSON.stringify(ii));

  /* ---------- 카메라 상태 조회 ---------- */
  const ci = await Cam.getInfo(canon);
  check('canon getInfo 모델', /EOS Mock/.test(ci.model || ''));
  check('canon getInfo 배터리/스토리지/온도', !!ci.battery && /GB/.test(ci.storage || '') && !!ci.temp,
    JSON.stringify({ battery: ci.battery, storage: ci.storage, temp: ci.temp }));
  const si = await Cam.getInfo(sony);
  check('sony getInfo 모델/배터리', /ILCE-MOCK/.test(si.model || '') && /%/.test(si.battery || ''),
    JSON.stringify(si));

  /* ---------- 오프라인 카메라: 타임아웃 안정성 ---------- */
  const dead = { type: 'canon', ip: '127.0.0.2' }; // 응답 없는 주소
  const t0 = Date.now();
  await Cam.test(dead).catch(() => {});
  check('dead cam test 실패 ≤3.5s', Date.now() - t0 < 3500);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
