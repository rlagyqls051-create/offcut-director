'use strict';
/* exporters.js — 로그 → 편집 포맷 변환 (FCPXML/SRT/CSV/EDL/JSON/OTIO)
 * app.js의 전역 헬퍼(pad, msToTC, durStr, clockStr, xmlEsc)를 사용.
 * 스크립트 로드는 capture.js → camera.js → exporters.js → app.js 순.
 */
const FPS_RAT = { 23.976: '1001/24000s', 24: '1/24s', 25: '1/25s', 29.97: '1001/30000s', 30: '1/30s', 50: '1/50s', 59.94: '1001/60000s', 60: '1/60s' };
const rat = ms => `${Math.round(ms)}/1000s`;
const LBL = { OK: '채택', KEEP: '보류', NG: '버림' };

function secsOf(t) {
  const dur = t.endMs - t.startMs;
  return (t.sections && t.sections.length) ? t.sections : [{ start: 0, end: dur, status: t.status }];
}

function buildFCPXML(onlySelects) {
  const fps = FPS_RAT[S.fps] || '1/25s';
  const portrait = S.mode === 'shoot' && S.videoOrient === 'portrait';
  const [vw, vh] = portrait ? [1080, 1920] : [1920, 1080];
  const fmtName = `FFVideoFormat${vw}x${vh}p${String(S.fps).replace('.', '')}`;
  const date = new Date().toISOString().slice(0, 10);

  const use = S.takes.map(t => ({ t, secs: secsOf(t).filter(s => !onlySelects || s.status !== 'NG') }))
    .filter(x => x.secs.length);
  const total = use.reduce((a, x) => a + x.secs.reduce((b, s) => b + s.end - s.start, 0), 0);

  const assets = use.map(({ t }) =>
    `    <asset id="a${t.num}" name="${xmlEsc(t.fname)}" start="0s" duration="${rat(t.endMs - t.startMs)}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2" audioRate="48000">\n` +
    `      <media-rep kind="original-media" src="file:///localhost/RELINK/${xmlEsc(t.fname)}"/>\n    </asset>`
  ).join('\n');

  let offset = 0;
  const clips = use.map(({ t, secs }) => secs.map((sec, si) => {
    const len = sec.end - sec.start;
    let mk = '';
    if (si === 0) mk += `\n        <marker start="0s" duration="1/1000s" value="T${pad(t.num, 2)} ${t.status}" note="${xmlEsc(t.note)}"/>`;
    if (sec.status === 'NG') mk += `\n        <marker start="0s" duration="${rat(len)}" value="버림 - 삭제" note="${xmlEsc(t.note)}"/>`;
    for (const m of (t.memos || [])) {
      if (m.ms >= sec.start && m.ms < sec.end)
        mk += `\n        <marker start="${rat(m.ms - sec.start)}" duration="1/1000s" value="${xmlEsc(m.text.slice(0, 60))}" note="${xmlEsc(m.text)}"/>`;
    }
    const c = `      <asset-clip ref="a${t.num}" offset="${rat(offset)}" name="T${pad(t.num, 2)}.${si + 1} ${LBL[sec.status] || sec.status}" start="${rat(sec.start)}" duration="${rat(len)}" format="r1" tcFormat="NDF" audioRole="dialogue">${mk}\n      </asset-clip>`;
    offset += len;
    return c;
  }).join('\n')).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="${fmtName}" frameDuration="${fps}" width="${vw}" height="${vh}" colorSpace="1-1-1 (Rec. 709)"/>
${assets}
  </resources>
  <library>
    <event name="offcut ${date}">
      <project name="${xmlEsc(S.project)} 촬영로그 ${date}${onlySelects ? ' (선택본)' : ''}">
        <sequence format="r1" duration="${rat(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

function srtT(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60, mm = Math.floor(ms % 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(mm, 3)}`;
}
function buildSRT() {
  let i = 0, out = '', offset = 0;
  for (const t of S.takes) {
    const dur = t.endMs - t.startMs;
    (t.memos || []).forEach((m, idx) => {
      const next = t.memos[idx + 1];
      const end = next ? next.ms : Math.min(m.ms + 4000, dur);
      out += `${++i}\n${srtT(offset + m.ms)} --> ${srtT(offset + end)}\n[T${pad(t.num, 2)}] ${m.text}\n\n`;
    });
    offset += dur;
  }
  return out;
}

function buildCSV() {
  const rows = [['take', 'clip_file', 'status', 'start_time', 'end_time', 'duration', 'sections', 'note', 'memos']];
  for (const t of S.takes) {
    const segs = secsOf(t).map(s => `${durStr(s.start)}-${durStr(s.end)} ${LBL[s.status] || s.status}`).join(' | ');
    rows.push([t.num, t.fname, t.status, clockStr(new Date(t.startMs)), clockStr(new Date(t.endMs)),
      durStr(t.endMs - t.startMs), segs, t.note,
      (t.memos || []).map(m => `${durStr(m.ms)} ${m.text}`).join(' | ')]);
  }
  return '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function buildEDL() {
  const LCOLOR = { OK: 'GREEN', KEEP: 'YELLOW', NG: 'RED' };
  let out = `TITLE: ${S.project}\nFCM: NON-DROP FRAME\n\n`;
  let rec = 0, i = 0;
  for (const t of S.takes) {
    secsOf(t).forEach((sec, si) => {
      i++;
      const reel = (t.fname.replace(/\.[^.]+$/, '') || 'AX').slice(0, 7);
      out += `${pad(i, 3)}  ${(reel + '        ').slice(0, 8)} V     C        ${msToTC(sec.start)} ${msToTC(sec.end)} ${msToTC(rec)} ${msToTC(rec + sec.end - sec.start)}\n`;
      out += `* FROM CLIP NAME: ${t.fname}\n`;
      out += `* LOC: ${msToTC(sec.start)} ${LCOLOR[sec.status] || 'NONE'} T${pad(t.num, 2)}.${si + 1} ${LBL[sec.status] || sec.status}\n`;
      if (t.note && si === 0) out += `* NOTE: ${t.note}\n`;
      out += '\n';
      rec += sec.end - sec.start;
    });
  }
  return out;
}

function buildJSON() {
  return JSON.stringify({
    project: S.project, fps: S.fps, mode: S.mode,
    generated: new Date().toISOString(),
    takes: S.takes.map(t => ({
      take: t.num, file: t.fname, verdict: t.status,
      start_wallclock: new Date(t.startMs).toISOString(),
      duration_ms: t.endMs - t.startMs,
      sections: (t.sections || []).map(s => ({ start_ms: s.start, end_ms: s.end, verdict: s.status })),
      memos: (t.memos || []).map(m => ({ ms: m.ms, text: m.text })),
      note: t.note || '',
      clip_recorded: !!(t.clip && t.clip !== 'failed' && t.clip !== 'rec'),
    })),
  }, null, 2);
}

/* OpenTimelineIO — AI/파이프라인 표준 컷리스트 */
function buildOTIO() {
  const rate = S.fps;
  const rt = ms => ({ "OTIO_SCHEMA": "RationalTime.1", "rate": rate, "value": Math.round(ms / 1000 * rate) });
  const tr = (a, b) => ({ "OTIO_SCHEMA": "TimeRange.1", "start_time": rt(a), "duration": rt(Math.max(0, b - a)) });
  const clips = [];
  for (const t of S.takes) {
    const dur = t.endMs - t.startMs;
    secsOf(t).forEach((sec, si) => {
      clips.push({
        "OTIO_SCHEMA": "Clip.2",
        "name": `T${pad(t.num, 2)}.${si + 1} ${LBL[sec.status] || sec.status}`,
        "media_reference": {
          "OTIO_SCHEMA": "ExternalReference.1",
          "target_url": t.fname,
          "available_range": tr(0, dur),
        },
        "source_range": tr(sec.start, sec.end),
        "metadata": { "offcut": {
          "take": t.num, "verdict": sec.status, "note": t.note || '',
          "memos": (t.memos || []).filter(m => m.ms >= sec.start && m.ms < sec.end).map(m => ({ ms: m.ms, text: m.text })),
        }},
      });
    });
  }
  return JSON.stringify({
    "OTIO_SCHEMA": "Timeline.1",
    "name": `${S.project} 촬영로그`,
    "global_start_time": rt(0),
    "tracks": { "OTIO_SCHEMA": "Stack.1", "children": [
      { "OTIO_SCHEMA": "Track.1", "kind": "Video", "name": "offcut", "children": clips },
    ]},
  }, null, 2);
}
