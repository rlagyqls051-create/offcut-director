'use strict';
const $ = s => document.querySelector(s);
const LS_KEY = 'offcut.v1';

/* ---------- state ---------- */
function fresh() {
  return {
    project: '오늘의 촬영',
    fps: 25,
    prefix: 'C',
    startNo: 1,
    slate: true,
    sound: true,
    mode: 'log',        // 'log' = 외부 카메라 로거 | 'shoot' = 폰 인앱 촬영
    facing: 'environment',
    videoOrient: 'landscape', // 'landscape' 16:9 | 'portrait' 9:16
    countdownSec: 0,    // 촬영 시작 카운트다운(초)
    camType: 'off',     // 'off' | 'canon' | 'sony' | 'sonyble' | 'insta360' | 'gopro' — 외부 카메라 연동
    camIp: '',
    takes: [],          // {num, fname, startMs, endMs, status, sections:[{start,end,status}], memos:[{ms,text}], note, clip}
    seq: 1,
    cur: null,          // rolling take: {num, fname, startMs, secStart, sections:[], memos:[], rec}
  };
}
let S;
try { S = Object.assign(fresh(), JSON.parse(localStorage.getItem(LS_KEY)) || {}); } catch { S = fresh(); }
if (S.cur && S.cur.rec) S.cur.rec = false; // 앱 재시작 — 녹화는 이미 끊겼으니 로깅만 이어감
const save = () => localStorage.setItem(LS_KEY, JSON.stringify(S));

/* ---------- helpers ---------- */
const pad = (n, l = 2) => String(n).padStart(l, '0');
function msToTC(ms) {
  const fps = S.fps;
  const totalF = Math.round(ms / 1000 * fps);
  const ff = Math.floor(totalF % fps);
  let s = Math.floor(totalF / fps);
  const ss = s % 60; s = Math.floor(s / 60);
  const mm = s % 60; const hh = Math.floor(s / 60);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}
const durStr = ms => {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}.${pad(Math.floor(ms % 1000 / 100))}`;
};
const clockStr = t => `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
const fileName = (num, ext) => `${S.prefix}${pad(S.startNo + num - 1, 4)}${ext || '.MP4'}`;
const buzz = p => { if (S.sound && navigator.vibrate) navigator.vibrate(p); };
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function beep() {
  if (!S.sound) return;
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1000; g.gain.value = 0.25;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.35);
  } catch {}
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (S.cur || S.mode === 'shoot') setWake(true);
    if (S.mode === 'shoot' && Capture.hasStream()) Capture.attachPreview($('#camView'));
  }
});

/* ---------- roll / cut / ng ---------- */
let cdTimer = null;
function endCd() {
  if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
  $('#cdOverlay').classList.add('hidden');
}
function roll(fromCam) {
  if (S.cur) return;
  if (!fromCam && S.mode === 'shoot' && Capture.supported() && S.countdownSec > 0) {
    let n = S.countdownSec;
    $('#cdNum').textContent = n;
    $('#cdOverlay').classList.remove('hidden');
    buzz(20);
    cdTimer = setInterval(() => {
      if (--n <= 0) { endCd(); startRoll(false); }
      else { $('#cdNum').textContent = n; buzz(15); }
    }, 1000);
    return;
  }
  startRoll(!!fromCam);
}
async function startRoll(fromCam) {
  buzz(30);
  const num = S.seq;
  let fname = fileName(num), rec = false;
  if (S.mode === 'shoot' && Capture.supported()) {
    try {
      if (!Capture.hasStream()) {
        await Capture.initCamera(S.facing, S.videoOrient);
        Capture.attachPreview($('#camView'));
      }
      fname = fileName(num, Capture.mimeExt(Capture.pickMime()));
      await Capture.startRecording(fname);
      rec = true;
    } catch {
      alert('카메라/녹화를 시작할 수 없어 이번 테이크는 로깅만 됩니다.');
    }
  }
  S.cur = { num, fname, startMs: Date.now(), secStart: 0, sections: [], memos: [], rec };
  save();
  // 카메라 명령은 백그라운드 — 응답 없는 카메라 때문에 롤이 블록되면 안 됨
  if (!fromCam && S.mode === 'log' && CamLink.isLinked(S)) {
    CamLink.recStart(S).catch(() => {
      if (S.cur && S.cur.num === num) alert('카메라 응답 없음 — 로깅만 진행됩니다.');
    });
  }
  if (S.slate) {
    $('#flash').classList.add('on');
    setTimeout(() => $('#flash').classList.remove('on'), 450);
    beep();
  }
  document.body.classList.add('rolling');
  setWake(true);
  render();
}

function sectionMark(status) {
  if (!S.cur) return;
  buzz(25);
  const now = Date.now() - S.cur.startMs;
  if (now - S.cur.secStart < 300) return; // 0.3초 미만 구간 무시 (오타치 방지)
  S.cur.sections.push({ start: S.cur.secStart, end: now, status });
  S.cur.secStart = now;
  save(); render();
}

function undoSection() {
  if (!S.cur || !S.cur.sections.length) return;
  buzz(15);
  S.cur.secStart = S.cur.sections.pop().start;
  save(); render();
}

function addMemo() {
  if (!S.cur) return;
  const text = $('#memoInput').value.trim();
  if (!text) return;
  buzz(10);
  S.cur.memos.push({ ms: Date.now() - S.cur.startMs, text });
  $('#memoInput').value = '';
  save(); render();
  const f = $('#memoFeed'); f.scrollTop = f.scrollHeight;
}

function cut(fromCam) {
  if (!S.cur) return;
  if (!$('#sheet').classList.contains('hidden')) return; // 시트 이미 열림 (폴링 에코 방지)
  buzz(40);
  if (!fromCam && S.mode === 'log' && CamLink.isLinked(S)) CamLink.recStop(S); // 판정 입력 기다리지 않고 즉시 정지 — 경계 정확도
  $('#sheetTitle').textContent = `테이크 ${S.cur.num} 종료 — 마지막 구간 판정`;
  $('#sheetNote').value = '';
  $('#sheet').classList.remove('hidden');
}

function judge(status) {
  const end = Date.now();
  const rel = end - S.cur.startMs;
  if (rel - S.cur.secStart >= 1) S.cur.sections.push({ start: S.cur.secStart, end: rel, status });
  const secs = S.cur.sections;
  const auto = secs.every(s => s.status === 'NG') ? 'NG' : secs.some(s => s.status === 'OK') ? 'OK' : 'KEEP';
  const stopP = S.cur.rec ? Capture.stopRecording() : null;
  const t = {
    num: S.cur.num, fname: S.cur.fname,
    startMs: S.cur.startMs, endMs: end,
    status: auto, sections: secs, memos: S.cur.memos, note: $('#sheetNote').value.trim(),
    clip: stopP ? 'rec' : null,
  };
  if (lastCamFile && Date.now() - lastCamFile.at < 8000) t.fname = lastCamFile.name; // 카메라가 만든 진짜 파일명
  S.takes.push(t);
  S.seq++; S.cur = null;
  save();
  $('#sheet').classList.add('hidden');
  document.body.classList.remove('rolling');
  setWake(S.mode === 'shoot');
  render();
  if (stopP) stopP
    .then(m => { t.clip = m; save(); render(); })
    .catch(() => { t.clip = 'failed'; save(); render(); });
}

/* ---------- timeline strip ---------- */
const PXS = 8; // px per second
const secHTML = s =>
  `<div class="tlSec ${s.status}" style="width:${Math.max(2, (s.end - s.start) / 1000 * PXS)}px"></div>`;
function renderTimeline() {
  $('#timeline').innerHTML = S.takes.map(t =>
    `<div class="tlTake" style="width:${Math.max(3, (t.endMs - t.startMs) / 1000 * PXS)}px">` +
    `<span class="tlNum">T${pad(t.num, 2)}</span>${(t.sections || []).map(secHTML).join('')}</div>`
  ).join('') +
  (S.cur ? `<div class="tlTake" id="tlCur"></div>` : '') +
  `<div id="playhead"></div>`;
}

/* ---------- render ---------- */
function render() {
  $('#hProject').textContent = S.project;
  $('#btnMode').textContent = S.mode === 'shoot' ? '폰 촬영' : '로거';
  $('#camWrap').classList.toggle('hidden', S.mode !== 'shoot');
  $('#btnRoll').classList.toggle('hidden', !!S.cur);
  $('#rollCtl').classList.toggle('hidden', !S.cur);
  document.body.classList.toggle('rolling', !!S.cur);
  $('#btnUndoSec').classList.toggle('hidden', !(S.cur && S.cur.sections.length));
  $('#memoBar').classList.toggle('hidden', !S.cur);
  $('#memoFeed').innerHTML = (S.cur ? S.cur.memos : []).map(m =>
    `<div class="mrow"><span class="mtc">${durStr(m.ms)}</span>${xmlEsc(m.text)}</div>`).join('');

  const list = $('#takeList');
  renderTimeline();
  if (!S.takes.length) {
    list.innerHTML = `<div class="empty">아직 테이크 없음 — ROLL을 눌러 시작<br>
      <span class="emptySub">${S.mode === 'shoot' ? 'ROLL이 곧 녹화 시작입니다' : '헤더의 모드를 폰 촬영으로 바꾸면 앱이 직접 녹화해요'}</span></div>`;
    return;
  }
  list.innerHTML = [...S.takes].reverse().map(t => {
    const note = t.note ? ` · ${t.note}` : '';
    const secN = (t.sections || []).length;
    const secInfo = secN > 1 ? `구간${secN}` : '';
    const clipOk = t.clip && t.clip !== 'failed' && t.clip !== 'rec';
    const clipSz = clipOk && t.clip.size ? ` · ${(t.clip.size / 1048576).toFixed(0)}MB` : '';
    return `<div class="trow">
      <span class="tno">T${pad(t.num, 2)}</span>
      <span class="tfile">${t.fname}</span>
      <span class="tdur">${durStr(t.endMs - t.startMs)}${clipSz}${note}</span>
      ${secInfo ? `<span class="ngbadge">${secInfo}</span>` : ''}
      ${t.clip === 'failed' ? `<span class="ngbadge">녹화실패</span>` : ''}
      ${t.clip === 'rec' ? `<span class="ngbadge">저장중…</span>` : ''}
      <button class="chip ${t.status}" data-num="${t.num}">${({OK:'채택',KEEP:'보류',NG:'버림'})[t.status] || t.status}</button>
      ${clipOk ? `<button class="cbtn" data-play="${t.num}">▶</button><button class="cbtn" data-share="${t.num}">⇪</button>` : ''}
      <button class="tdel" data-del="${t.num}">×</button>
    </div>` +
    (t.sections || []).map((s, i) => {
      if (s.status === 'OK' && secN <= 1) return '';
      const adj = i < secN - 1
        ? ` <button class="badj" data-adj="${t.num}:${i}:-500">◂0.5</button><button class="badj" data-adj="${t.num}:${i}:500">0.5▸</button>` : '';
      return `<div class="mline">└ ${durStr(s.start)}–${durStr(s.end)} ${({OK:'채택',KEEP:'보류',NG:'버림'})[s.status]}${adj}</div>`;
    }).join('') +
    (t.memos || []).map(m => `<div class="mline">└ ${durStr(m.ms)} — ${xmlEsc(m.text)}</div>`).join('');
  }).join('');
}

/* ---------- 카메라 상태 폴링 — 카메라 측 REC 자동 감지 ---------- */
let lastCamFile = null;
function onCamEvent(ev) {
  if (ev.type === 'health') {
    const ld = $('#linkDot');
    if (!ld.classList.contains('hidden')) ld.className = ev.ok ? 'ok' : 'err';
    return;
  }
  if (S.mode !== 'log') return;
  if (ev.type === 'state') {
    if (ev.recording && !S.cur) roll(true);
    else if (!ev.recording && S.cur) cut(true);
  } else if (ev.type === 'file') {
    lastCamFile = { name: ev.name, at: Date.now() };
    if (S.cur) {
      S.cur.fname = ev.name; save();
      $('#takeLabel').textContent = `REC · 테이크 ${S.cur.num} · ${S.cur.fname}`;
    }
  }
}
function syncPoll() {
  const on = S.mode === 'log' && CamLink.isLinked(S);
  if (on) CamLink.startPoll(S, onCamEvent); else CamLink.stopPoll();
  const ld = $('#linkDot');
  if (!ld) return;
  ld.className = CamLink.isLinked(S) ? 'idle' : 'hidden';
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncPoll(); });

/* ---------- clock loop (40ms — DOM 쓰기는 변할 때만) ---------- */
let lastClockTxt = '', tlSecsN = -1;
setInterval(() => {
  const now = Date.now();
  if (S.cur) {
    const rel = now - S.cur.startMs;
    const txt = msToTC(rel);
    if (txt !== lastClockTxt) {
      lastClockTxt = txt;
      $('#clock').textContent = txt;
      $('#sheetClock').textContent = txt;
    }
    $('#takeLabel').textContent = `REC · 테이크 ${S.cur.num} · ${S.cur.fname}`;
    $('#wallSub').textContent = `시작 ${clockStr(new Date(S.cur.startMs))}`;
    // 녹화 워치독 — 레코더가 조용히 죽었으면 표시하고 로깅만 유지
    if (S.cur.rec && !Capture.isRecording()) {
      S.cur.rec = false; save();
      alert('녹화가 중단됐습니다 — 이 테이크는 로깅만 저장됩니다.');
    }
    const cur = $('#tlCur');
    if (cur) {
      const secsN = S.cur.sections.length;
      if (secsN !== tlSecsN) { // 구간 변동 때만 재렌더
        tlSecsN = secsN;
        cur.innerHTML = `<span class="tlNum">T${pad(S.cur.num, 2)}</span>` +
          S.cur.sections.map(secHTML).join('') + `<div class="tlSec cur"></div>`;
      }
      cur.style.width = Math.max(3, rel / 1000 * PXS) + 'px';
      const cw = cur.querySelector('.tlSec.cur');
      if (cw) cw.style.width = Math.max(2, (rel - S.cur.secStart) / 1000 * PXS) + 'px';
      const base = S.takes.reduce((a, t) => a + (t.endMs - t.startMs), 0);
      const ph = (base + rel) / 1000 * PXS;
      $('#playhead').style.left = ph + 'px';
      const w = $('#tlWrap');
      w.scrollLeft = ph - w.clientWidth + 40;
    }
  } else {
    tlSecsN = -1;
    const txt = clockStr(new Date());
    if (txt !== lastClockTxt) { lastClockTxt = txt; $('#clock').textContent = txt; }
    $('#takeLabel').textContent = 'STANDBY';
    $('#wallSub').textContent = S.takes.length ? `테이크 ${S.takes.length}개 기록됨` : '';
  }
}, 40);

async function sendFile(name, text, mime) { return Capture.exportFile(name, text, mime); }

const safeName = () => `${S.project.replace(/\s+/g, '_')}_촬영로그_${new Date().toISOString().slice(0, 10)}`;

/* ---------- wiring ---------- */
$('#btnRoll').addEventListener('click', roll);
document.querySelectorAll('.jbtn').forEach(b => b.addEventListener('click', () => sectionMark(b.dataset.j)));
$('#btnUndoSec').addEventListener('click', undoSection);
$('#btnCut').addEventListener('click', cut);
$('#sheetCancel').addEventListener('click', () => $('#sheet').classList.add('hidden'));
$('#memoSend').addEventListener('click', addMemo);
$('#memoInput').addEventListener('keydown', e => { if (e.key === 'Enter') addMemo(); });
document.querySelectorAll('.judge').forEach(b => b.addEventListener('click', () => { buzz(30); judge(b.dataset.s); }));

/* ---------- clip player ---------- */
let playerKey = null;
async function openPlayer(t) {
  const src = await Capture.getClipSrc(t.fname).catch(() => null);
  if (!src) return alert('클립을 찾을 수 없습니다.');
  playerKey = t.fname;
  $('#playerTitle').textContent = `T${pad(t.num, 2)} · ${t.fname}`;
  $('#playerView').src = src;
  $('#playerSheet').classList.remove('hidden');
}
$('#playerClose').addEventListener('click', () => {
  $('#playerView').pause(); $('#playerView').removeAttribute('src'); $('#playerView').load();
  $('#playerSheet').classList.add('hidden'); playerKey = null;
});
$('#playerShare').addEventListener('click', () => {
  if (playerKey) Capture.shareClip(playerKey).catch(() => alert('클립 공유에 실패했습니다.'));
});

$('#takeList').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  const playB = e.target.closest('[data-play]');
  const shareB = e.target.closest('[data-share]');
  const adjB = e.target.closest('[data-adj]');
  const del = e.target.closest('[data-del]');
  if (chip) {
    const t = S.takes.find(x => x.num == chip.dataset.num);
    t.status = t.status === 'OK' ? 'NG' : t.status === 'NG' ? 'KEEP' : 'OK';
    save(); render();
  }
  if (playB) {
    const t = S.takes.find(x => x.num == playB.dataset.play);
    if (t) openPlayer(t);
  }
  if (shareB) {
    const t = S.takes.find(x => x.num == shareB.dataset.share);
    if (t) Capture.shareClip(t.fname).catch(() => alert('클립 공유에 실패했습니다.'));
  }
  if (adjB) {
    const [num, si, d] = adjB.dataset.adj.split(':');
    const t = S.takes.find(x => x.num == num);
    const i = +si, dd = +d, secs = t && t.sections;
    if (secs && i < secs.length - 1) {
      const b = secs[i].end + dd;
      if (b - secs[i].start >= 300 && secs[i + 1].end - b >= 300) {
        secs[i].end = b; secs[i + 1].start = b;
        save(); render();
      }
    }
  }
  if (del) {
    const num = +del.dataset.del;
    if (confirm(`테이크 ${num} 로그 삭제? (녹화 클립도 함께 삭제)`)) {
      const t = S.takes.find(x => x.num === num);
      if (t && t.clip && t.clip !== 'failed' && t.clip !== 'rec') Capture.deleteClip(t.fname);
      S.takes = S.takes.filter(x => x.num !== num);
      save(); render();
    }
  }
});

$('#btnExport').addEventListener('click', () => $('#exportSheet').classList.remove('hidden'));
$('#expCancel').addEventListener('click', () => $('#exportSheet').classList.add('hidden'));
$('#expFcp').addEventListener('click', () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  sendFile(safeName() + '.fcpxml', buildFCPXML(false), 'application/xml');
});
$('#expFcpSel').addEventListener('click', () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  const xml = buildFCPXML(true);
  if (!xml.includes('<asset-clip')) return alert('채택/보류 구간이 없습니다.');
  sendFile(safeName() + '_선택본.fcpxml', xml, 'application/xml');
});
$('#expSrt').addEventListener('click', () => {
  const srt = buildSRT();
  if (!srt) return alert('기록된 메모가 없습니다.');
  sendFile(safeName() + '.srt', srt, 'application/x-subrip');
});
$('#expCsv').addEventListener('click', () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  sendFile(safeName() + '.csv', buildCSV(), 'text/csv');
});
$('#expEdl').addEventListener('click', () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  sendFile(safeName() + '.edl', buildEDL(), 'text/plain');
});
$('#expJson').addEventListener('click', () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  sendFile(safeName() + '.json', buildJSON(), 'application/json');
});
$('#expOtio').addEventListener('click', () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  sendFile(safeName() + '.otio', buildOTIO(), 'application/json');
});
const clipTakes = () => S.takes.filter(t => t.clip && t.clip !== 'failed' && t.clip !== 'rec');
$('#expClipsAll').addEventListener('click', async () => {
  const list = clipTakes();
  if (!list.length) return alert('녹화된 클립이 없습니다.');
  await Capture.shareAllClips(list.map(t => t.fname), safeName() + '_clips.zip')
    .catch(e => { if (e.name !== 'AbortError') alert('클립 공유에 실패했습니다.'); });
});
$('#expZip').addEventListener('click', async () => {
  if (!S.takes.length) return alert('기록된 테이크가 없습니다.');
  const enc = new TextEncoder();
  const entries = [
    { name: safeName() + '.fcpxml', data: enc.encode(buildFCPXML()) },
    { name: safeName() + '.csv', data: enc.encode(buildCSV()) },
    { name: safeName() + '.json', data: enc.encode(buildJSON()) },
    { name: safeName() + '.edl', data: enc.encode(buildEDL()) },
    { name: safeName() + '.otio', data: enc.encode(buildOTIO()) },
  ];
  const srt = buildSRT();
  if (srt) entries.push({ name: safeName() + '.srt', data: enc.encode(srt) });
  for (const t of clipTakes()) {
    const data = await Capture.readClipBytes(t.fname).catch(() => null);
    if (data) entries.push({ name: t.fname, data });
  }
  await Capture.exportZip(safeName() + '.zip', entries)
    .catch(e => { if (e.name !== 'AbortError') alert('패키지 생성에 실패했습니다.'); });
});

/* ---------- shoot mode ---------- */
async function applyMode() {
  if (S.mode === 'shoot' && !Capture.supported()) {
    alert('이 기기/브라우저는 인앱 녹화를 지원하지 않습니다. 카메라 로거 모드를 사용하세요.');
    S.mode = 'log'; save();
  }
  $('#camWrap').classList.toggle('hidden', S.mode !== 'shoot');
  document.body.classList.toggle('selfcam', S.facing === 'user');
  document.body.classList.toggle('vport', S.videoOrient === 'portrait');
  setWake(S.mode === 'shoot' || !!S.cur);
  if (S.mode === 'shoot') {
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => {
      const free = (e.quota || 0) - (e.usage || 0);
      if (free && free < 1.5e9) alert(`저장 여유가 ${(free / 1e9).toFixed(1)}GB 뿐입니다. 긴 녹화 전 공간을 확보하세요.`);
    }).catch(() => {});
    try { await Capture.initCamera(S.facing, S.videoOrient); Capture.attachPreview($('#camView')); }
    catch { /* 권한 거부 등 — ROLL 시점에 재시도 */ }
  } else {
    Capture.stopCamera(); $('#camView').srcObject = null;
  }
  syncPoll();
}
$('#btnMode').addEventListener('click', () => {
  if (S.cur) return alert('롤 중에는 모드를 바꿀 수 없어요. CUT 후 변경하세요.');
  S.mode = S.mode === 'shoot' ? 'log' : 'shoot';
  save(); render(); applyMode();
});
$('#btnFlipCam').addEventListener('click', async () => {
  S.facing = S.facing === 'environment' ? 'user' : 'environment';
  save();
  document.body.classList.toggle('selfcam', S.facing === 'user');
  try { await Capture.initCamera(S.facing, S.videoOrient); Capture.attachPreview($('#camView')); }
  catch { alert('카메라 전환에 실패했습니다.'); }
});
$('#cdSkip').addEventListener('click', () => { endCd(); startRoll(); });
$('#cdCancel').addEventListener('click', endCd);

$('#btnSettings').addEventListener('click', () => {
  $('#setMode').value = S.mode;
  $('#setFacing').value = S.facing;
  $('#setOrient').value = S.videoOrient;
  $('#setCd').value = String(S.countdownSec);
  $('#setCamType').value = S.camType;
  $('#setCamIp').value = S.camIp;
  $('#camIpFld').classList.toggle('hidden', CamLink.isBle(S.camType) || S.camType === 'off');
  $('#camLinkStat').textContent = '';
  $('#setProject').value = S.project;
  $('#setFps').value = String(S.fps);
  $('#setPrefix').value = S.prefix;
  $('#setStartNo').value = S.startNo;
  $('#setSlate').checked = S.slate;
  $('#setSound').checked = S.sound;
  $('#setSheet').classList.remove('hidden');
});
$('#setCamType').addEventListener('change', () => {
  const t = $('#setCamType').value;
  const ble = CamLink.isBle(t);
  if (t !== 'off' && !ble && !$('#setCamIp').value.trim()) $('#setCamIp').value = CamLink.defaultIp(t);
  // BLE는 IP 불필요 — 필드 숨김
  $('#camIpFld').classList.toggle('hidden', ble || t === 'off');
  if (ble) $('#camLinkStat').textContent = '테스트를 누르면 카메라를 블루투스로 스캔합니다 (최대 12초)';
});
$('#camTest').addEventListener('click', async () => {
  const c = { type: $('#setCamType').value, ip: $('#setCamIp').value.trim() };
  const st = $('#camLinkStat');
  st.textContent = CamLink.isBle(c.type) ? '카메라 스캔 중… (최대 12초 — 카메라를 연결 가능한 상태로 두세요)' : '연결 확인 중… (카메라 Wi-Fi 접속 상태 확인)';
  try {
    const msg = await CamLink.test(c);
    st.textContent = '✓ ' + msg;
    const info = await CamLink.getInfo(c).catch(() => null);
    if (info) {
      const lines = [];
      if (info.model) lines.push(`모델 ${info.model}${info.fw ? ' · FW ' + info.fw : ''}`);
      if (info.battery) lines.push(`배터리 ${info.battery}`);
      if (info.storage) lines.push(`스토리지 ${info.storage}`);
      if (info.temp) lines.push(`온도 ${info.temp}`);
      if (lines.length) st.innerHTML = '✓ ' + xmlEsc(msg) + '<br>' + lines.map(xmlEsc).join('<br>');
    }
  }
  catch { st.textContent = CamLink.isBle(c.type) ? '✗ 연결 실패 — 카메라 전원/페어링 설정을 확인하고 가까이 두세요' : '✗ 연결 실패 — 카메라가 켜져 있고 폰이 카메라 Wi-Fi에 붙었는지 확인'; }
});

$('#setClose').addEventListener('click', () => {
  S.mode = $('#setMode').value;
  S.facing = $('#setFacing').value;
  S.videoOrient = $('#setOrient').value;
  S.countdownSec = +$('#setCd').value || 0;
  S.camType = $('#setCamType').value;
  S.camIp = $('#setCamIp').value.trim();
  S.project = $('#setProject').value.trim() || '오늘의 촬영';
  S.fps = parseFloat($('#setFps').value);
  S.prefix = $('#setPrefix').value.trim() || 'C';
  S.startNo = +$('#setStartNo').value || 1;
  S.slate = $('#setSlate').checked;
  S.sound = $('#setSound').checked;
  save(); render(); applyMode();
  $('#setSheet').classList.add('hidden');
});
$('#setReset').addEventListener('click', () => {
  if (confirm('테이크 로그를 전부 삭제할까요? (녹화 클립 포함, 되돌릴 수 없음)')) {
    S.takes.forEach(t => { if (t.clip && t.clip !== 'failed' && t.clip !== 'rec') Capture.deleteClip(t.fname); });
    S.takes = []; S.seq = 1; S.cur = null;
    save(); render();
    $('#setSheet').classList.add('hidden');
    document.body.classList.remove('rolling', 'ngseg');
  }
});

/* ---------- remote / keyboard ---------- */
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.repeat) return;
  const k = e.key;
  if (!$('#cdOverlay').classList.contains('hidden')) {
    if (k === 'Escape' || k === ' ') { e.preventDefault(); endCd(); }
    else if (k === 'Enter') { e.preventDefault(); endCd(); startRoll(); }
    return;
  }
  if (!$('#sheet').classList.contains('hidden')) {
    if (k === 'Enter' || k === '1' || k === 'PageDown' || k === 'ArrowRight') { e.preventDefault(); judge('OK'); }
    else if (k === '2' || k === 'ArrowUp') { e.preventDefault(); judge('KEEP'); }
    else if (k === '3' || k === 'PageUp' || k === 'ArrowLeft') { e.preventDefault(); judge('NG'); }
    else if (k === 'Escape') $('#sheet').classList.add('hidden');
    return;
  }
  if (k === 'Escape') {
    ['#exportSheet', '#setSheet', '#playerSheet'].forEach(s => $(s).classList.add('hidden'));
    return;
  }
  if (S.cur) {
    if (k === 'PageDown' || k === 'ArrowRight') { e.preventDefault(); sectionMark('OK'); }
    else if (k === 'ArrowUp') { e.preventDefault(); sectionMark('KEEP'); }
    else if (k === 'PageUp' || k === 'ArrowLeft') { e.preventDefault(); sectionMark('NG'); }
    else if (k === 'ArrowDown' || k === 'Backspace') { e.preventDefault(); undoSection(); }
    else if (k === ' ' || k === 'Enter') { e.preventDefault(); cut(); }
  } else if (k === ' ' || k === 'Enter') { e.preventDefault(); roll(); }
});

render();
applyMode();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && !Capture.isNative()) navigator.serviceWorker.register('sw.js').catch(() => {});
