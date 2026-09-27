'use strict';
/* e2e.js — 실제 app.js 전체 플로우 E2E 테스트 (mockcam 필요)
 *   터미널1: node tools/mockcam.js
 *   터미널2: node tools/e2e.js
 * 검증: 카메라 폴링 → 외부 REC 자동 롤/컷 → addedcontents 진짜 파일명 매핑 →
 *       수동 ROLL/CUT → 구간 판정/메모 → JSON export
 */
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗ FAIL'} ${name} ${extra}`); };

/* ---------- DOM/브라우저 스텁 ---------- */
const els = {};
function makeEl(id) {
  const cls = new Set(['sheet', 'exportSheet', 'setSheet', 'playerSheet', 'cdOverlay', 'linkDot'].includes(id) ? ['hidden'] : []);
  const el = {
    id, _cls: cls, _ls: {}, value: '', checked: false, textContent: '', innerHTML: '',
    style: {}, dataset: {}, srcObject: null, src: '', scrollTop: 0, scrollHeight: 0, scrollLeft: 0,
    clientWidth: 600, tagName: 'DIV', children: [],
  };
  el.classList = {
    add: c => cls.add(c), remove: c => cls.delete(c),
    toggle: (c, f) => (f === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : f ? cls.add(c) : cls.delete(c)),
    contains: c => cls.has(c),
  };
  Object.defineProperty(el, 'className', {
    get: () => [...cls].join(' '),
    set: v => { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => cls.add(c)); },
  });
  el.addEventListener = (t, fn) => { (el._ls[t] = el._ls[t] || []).push(fn); };
  el.fire = (t, ev = {}) => (el._ls[t] || []).forEach(fn => fn(ev));
  el.querySelector = () => makeEl('q');
  el.closest = () => null;
  el.click = () => el.fire('click');
  el.focus = el.load = el.pause = el.removeAttribute = el.appendChild = () => {};
  return el;
}
const E = id => els[id] || (els[id] = makeEl(id));
const docLs = {};
const downloads = [];
const jbtns = ['OK', 'KEEP', 'NG'].map(j => { const e = makeEl('jbtn'); e.dataset.j = j; return e; });
const judges = ['OK', 'KEEP', 'NG'].map(s => { const e = makeEl('judge'); e.dataset.s = s; return e; });

globalThis.window = globalThis;
globalThis.document = {
  querySelector: s => s.startsWith('#') ? E(s.slice(1)) : makeEl(s),
  querySelectorAll: s => s === '.jbtn' ? jbtns : s === '.judge' ? judges : [],
  createElement: () => { const e = makeEl('a'); e.click = () => downloads.push(e); return e; },
  addEventListener: (t, fn) => { (docLs[t] = docLs[t] || []).push(fn); },
  body: { classList: makeEl('body').classList },
  visibilityState: 'visible',
};
const store = {};
globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = v, removeItem: k => delete store[k] };
Object.defineProperty(globalThis, 'navigator', { value: { canShare: () => false }, configurable: true });
globalThis.alert = m => { globalThis.__alerts = (globalThis.__alerts || []); __alerts.push(m); };
globalThis.confirm = () => true;
const __objUrls = {};
const __origCreate = URL.createObjectURL && URL.createObjectURL.bind(URL);
URL.createObjectURL = b => { const u = __origCreate ? __origCreate(b) : 'blob:mock' + Math.random(); __objUrls[u] = b; return u; };
URL.revokeObjectURL = () => {};
const key = k => (docLs.keydown || []).forEach(fn => fn({ key: k, target: { tagName: 'DIV' }, repeat: false, preventDefault: () => {} }));

/* ---------- 앱 로드 ---------- */
const src = ['capture.js', 'camera.js', 'exporters.js', 'app.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'www', f), 'utf8').replace(/^'use strict';/, ''))
  .join('\n;\n');
eval(src + '\n;globalThis.__appLoaded = { S };');

const BASE = 'http://127.0.0.1:8080';
const savedState = () => JSON.parse(store['offcut.v1'] || '{}');

(async () => {
  await sleep(100);
  /* 1. 설정: Canon 연동 */
  Object.assign(E('setMode'), { value: 'log' });
  Object.assign(E('setFacing'), { value: 'environment' });
  Object.assign(E('setOrient'), { value: 'landscape' });
  Object.assign(E('setCd'), { value: '0' });
  Object.assign(E('setCamType'), { value: 'canon' });
  Object.assign(E('setCamIp'), { value: '127.0.0.1' });
  Object.assign(E('setProject'), { value: 'E2E테스트' });
  Object.assign(E('setFps'), { value: '25' });
  Object.assign(E('setPrefix'), { value: 'C' });
  Object.assign(E('setStartNo'), { value: '1' });
  E('setSlate').checked = true; E('setSound').checked = false;
  E('setClose').fire('click');
  await sleep(300);
  check('설정 저장 (camType=canon)', savedState().camType === 'canon');
  check('링크 점 표시됨', !E('linkDot').classList.contains('hidden'));

  /* 2. 카메라에서 REC 직접 누름 → 폴링이 자동 롤 */
  await fetch(`${BASE}/control?rec=on`);
  await sleep(1700); // 폴링 주기 1.2s + 여유
  const tl = E('takeLabel').textContent;
  check('카메라 측 REC → 자동 롤', /REC · 테이크 1/.test(tl), `(${tl})`);

  /* 3. 롤 중 구간 판정 + 메모 */
  key('PageDown');       // 구간0 채택
  await sleep(400);
  key('ArrowUp');        // 구간1 보류
  E('memoInput').value = 'E2E 메모'; E('memoSend').fire('click');
  await sleep(300);

  /* 4. 카메라에서 정지 → 자동 컷 + 진짜 파일명 매핑 */
  const offRes = await fetch(`${BASE}/control?rec=off`).then(r => r.json());
  const realName = offRes.lastFile;
  await sleep(1700);
  check('카메라 측 정지 → 판정 시트 오픈', !E('sheet').classList.contains('hidden'));
  key('1'); // judge OK
  await sleep(200);
  let st = savedState();
  check('테이크 저장', st.takes.length === 1);
  check('진짜 파일명 매핑 (addedcontents)', st.takes[0].fname === realName, `(fname=${st.takes[0].fname}, real=${realName})`);
  check('구간 판정 기록', st.takes[0].sections.length === 3, JSON.stringify(st.takes[0].sections.map(s => s.status)));
  check('메모 기록', st.takes[0].memos.length === 1);

  /* 5. 수동 ROLL → 앱이 카메라 REC 명령 발송 */
  key('Enter');
  await sleep(600);
  check('수동 ROLL → recbutton start 발송', (await (await fetch(`${BASE}/calls`)).json()).some(c => c.path.includes('recbutton') && c.body.includes('start')));
  check('수동 롤 진행 중', /REC · 테이크 2/.test(E('takeLabel').textContent));
  await sleep(500);
  key(' '); // CUT → 시트 오픈 + 카메라 정지 명령
  await sleep(500);
  check('CUT → recbutton stop 발송', (await (await fetch(`${BASE}/calls`)).json()).some(c => c.path.includes('recbutton') && c.body.includes('stop')));
  key('3'); // judge NG
  await sleep(200);
  st = savedState();
  check('테이크 2 저장', st.takes.length === 2 && st.takes[1].status === 'NG');

  /* 6. JSON export 내용 검증 */
  E('expJson').fire('click');
  await sleep(300);
  check('JSON 다운로드 발생', downloads.length > 0);
  if (downloads.length) {
    const blob = __objUrls[downloads[0].href];
    const j = JSON.parse(await blob.text());
    check('JSON take1 파일명 = 카메라 파일명', j.takes[0].file === realName);
    check('JSON 구간 verdict 보존', j.takes[0].sections.length === 3);
  }

  /* 7. 오프라인 카메라에서도 ROLL은 로깅 유지 */
  st = savedState(); st.camIp = '127.0.0.2'; store['offcut.v1'] = JSON.stringify(st);
  // S는 이미 로드됨 — camIp를 바꾸려면 설정 시트 재사용
  E('setCamIp').value = '127.0.0.2'; E('setClose').fire('click');
  await sleep(100);
  const tRoll = Date.now();
  key('Enter');
  await sleep(200);
  check('롤은 즉시 진행됨 (카메라 대기 없음)', /REC · 테이크 3/.test(E('takeLabel').textContent) && Date.now() - tRoll < 1000);
  await sleep(6000); // recStart 타임아웃 (moviemode+recbutton 최대 ~5s)
  check('죽은 카메라 → 로깅만 진행 (alert 표시)', (globalThis.__alerts || []).some(a => a.includes('카메라 응답 없음')));
  key(' '); await sleep(300); key('1'); await sleep(200);
  check('테이크 3 저장 (카메라 없이)', savedState().takes.length === 3);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E crash:', e); process.exit(1); });
