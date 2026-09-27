'use strict';
/* capture.js — 인앱 녹화 + 클립 저장 + 파일 내보내기 추상화
 * 네이티브(Capacitor): Filesystem(Data/clips/) + Share 플러그인
 * 웹(PWA): IndexedDB('offcut-clips') + Web Share / 다운로드
 */
const Capture = (() => {
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const FS = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
  const SH = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;

  /* ---------- mime ---------- */
  const MIME_CANDS = [
    'video/mp4',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  function pickMime() {
    if (!window.MediaRecorder) return null;
    for (const m of MIME_CANDS) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return null;
  }
  const supported = () =>
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && pickMime());
  const mimeExt = m => (m && m.startsWith('video/webm') ? '.webm' : '.MP4');

  /* ---------- camera ---------- */
  let stream = null;
  async function initCamera(facing, orient) {
    stopCamera();
    const portrait = orient === 'portrait';
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: { ideal: facing || 'environment' },
        width: { ideal: portrait ? 1080 : 1920 },
        height: { ideal: portrait ? 1920 : 1080 },
        frameRate: { ideal: 30 },
      },
    });
    return stream;
  }
  function attachPreview(el) {
    if (el && stream) { el.srcObject = stream; el.play().catch(() => {}); }
  }
  function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  /* ---------- IndexedDB (web) ---------- */
  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('offcut-clips', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('clips');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbPut(key, blob) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').put(blob, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const r = db.transaction('clips').objectStore('clips').get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idbDel(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').delete(key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  /* ---------- recording ---------- */
  const blobToB64 = blob => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });

  let rec = null; // {recorder, mime, key, chunks, writeQ, failed}
  async function startRecording(key) {
    const mime = pickMime();
    if (!stream || !mime) throw new Error('녹화를 시작할 수 없음');
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    rec = { recorder, mime, key, chunks: [], writeQ: Promise.resolve(), failed: false };
    if (isNative()) {
      try { await FS().deleteFile({ path: 'clips/' + key, directory: 'DOCUMENTS' }); } catch {}
      rec.writeQ = FS().writeFile({ path: 'clips/' + key, data: '', directory: 'DOCUMENTS', recursive: true });
    }
    recorder.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      if (isNative()) {
        rec.writeQ = rec.writeQ
          .then(() => blobToB64(e.data))
          .then(b64 => FS().appendFile({ path: 'clips/' + key, data: b64, directory: 'DOCUMENTS' }))
          .catch(() => { rec.failed = true; });
      } else {
        rec.chunks.push(e.data);
      }
    };
    recorder.onerror = () => { rec.failed = true; };
    recorder.start(1000);
  }

  function stopRecording() {
    return new Promise((res, rej) => {
      if (!rec) return rej(new Error('녹화 중 아님'));
      const r = rec; rec = null;
      r.recorder.onstop = async () => {
        try {
          await r.writeQ;
          if (r.failed) throw new Error('녹화 쓰기 실패');
          let size = 0;
          if (isNative()) {
            const st = await FS().stat({ path: 'clips/' + r.key, directory: 'DOCUMENTS' });
            size = st.size || 0;
          } else {
            const blob = new Blob(r.chunks, { type: r.mime });
            size = blob.size;
            await idbPut(r.key, blob);
          }
          res({ mime: r.mime, size });
        } catch (e) { rej(e); }
      };
      try { r.recorder.stop(); } catch (e) { rej(e); }
    });
  }
  const recording = () => !!rec;

  /* ---------- clip access ---------- */
  async function getClipSrc(key) {
    if (isNative()) {
      const { uri } = await FS().getUri({ path: 'clips/' + key, directory: 'DOCUMENTS' });
      return window.Capacitor.convertFileSrc ? window.Capacitor.convertFileSrc(uri) : uri;
    }
    const blob = await idbGet(key);
    return blob ? URL.createObjectURL(blob) : null;
  }
  async function deleteClip(key) {
    if (isNative()) {
      try { await FS().deleteFile({ path: 'clips/' + key, directory: 'DOCUMENTS' }); } catch {}
    } else {
      await idbDel(key).catch(() => {});
    }
  }
  async function shareClip(key) {
    if (isNative() && SH()) {
      const { uri } = await FS().getUri({ path: 'clips/' + key, directory: 'DOCUMENTS' });
      await SH().share({ title: key, url: uri });
      return;
    }
    const blob = await idbGet(key);
    if (!blob) throw new Error('클립 없음');
    const f = new File([blob], key, { type: blob.type || 'video/mp4' });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      await navigator.share({ files: [f], title: key });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = key; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- zip (STORE, 무압축 — 영상은 이미 압축됨) ---------- */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
    return t;
  })();
  const crc32 = bytes => { let c = ~0; for (const b of bytes) c = CRC_T[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const bytesToB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };
  const dosDT = (d = new Date()) => ({
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  });

  function buildZip(entries) { // entries: [{name, data:Uint8Array}]
    const enc = new TextEncoder();
    const u16 = v => new Uint8Array([v & 255, (v >>> 8) & 255]);
    const u32 = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
    const parts = [], cds = [];
    let off = 0;
    const push = a => { parts.push(a); off += a.length; };
    const dt = dosDT();
    for (const e of entries) {
      const nb = enc.encode(e.name);
      const crc = crc32(e.data);
      const lo = off;
      [u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
        u32(crc), u32(e.data.length), u32(e.data.length), u16(nb.length), u16(0), nb, e.data].forEach(push);
      cds.push({ nb, crc, size: e.data.length, dt, lo });
    }
    const cdStart = off;
    for (const c of cds) {
      [u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(c.dt.time), u16(c.dt.date),
        u32(c.crc), u32(c.size), u32(c.size), u16(c.nb.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(c.lo), c.nb].forEach(push);
    }
    [u32(0x06054b50), u16(0), u16(0), u16(cds.length), u16(cds.length), u32(off - cdStart), u32(cdStart), u16(0)].forEach(push);
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let p = 0; for (const a of parts) { out.set(a, p); p += a.length; }
    return out;
  }

  async function readClipBytes(key) {
    if (isNative()) {
      const r = await FS().readFile({ path: 'clips/' + key, directory: 'DOCUMENTS' });
      return b64ToBytes(r.data);
    }
    const blob = await idbGet(key);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  async function shareAllClips(keys, zipName) {
    if (isNative() && SH()) {
      const uris = [];
      for (const k of keys) {
        try { uris.push((await FS().getUri({ path: 'clips/' + k, directory: 'DOCUMENTS' })).uri); } catch {}
      }
      if (uris.length) { await SH().share({ files: uris }); return; }
    }
    const files = [];
    for (const k of keys) {
      const blob = await idbGet(k).catch(() => null);
      if (blob) files.push(new File([blob], k, { type: blob.type || 'video/mp4' }));
    }
    if (files.length && navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: zipName });
      return;
    }
    // 폴백: zip으로 다운로드
    const entries = [];
    for (const f of files) entries.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    if (!entries.length) throw new Error('클립 없음');
    await exportZip(zipName, entries);
  }

  async function exportZip(name, entries) {
    const bytes = buildZip(entries);
    if (isNative()) {
      await FS().writeFile({ path: 'export/' + name, data: bytesToB64(bytes), directory: 'CACHE', recursive: true });
      const { uri } = await FS().getUri({ path: 'export/' + name, directory: 'CACHE' });
      await SH().share({ title: name, url: uri });
      return;
    }
    const f = new File([bytes], name, { type: 'application/zip' });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- text file export (FCPXML/SRT/CSV/EDL) ---------- */
  async function exportFile(name, text, mime) {
    if (isNative()) {
      await FS().writeFile({ path: 'export/' + name, data: btoa(unescape(encodeURIComponent(text))), directory: 'CACHE', recursive: true });
      const { uri } = await FS().getUri({ path: 'export/' + name, directory: 'CACHE' });
      await SH().share({ title: name, url: uri });
      return;
    }
    const f = new File([text], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  return {
    isNative, supported, pickMime, mimeExt,
    initCamera, attachPreview, stopCamera, hasStream: () => !!stream,
    startRecording, stopRecording, recording,
    isRecording: () => !!(rec && rec.recorder && rec.recorder.state === 'recording'),
    getClipSrc, deleteClip, shareClip, exportFile,
    readClipBytes, shareAllClips, exportZip,
  };
})();
