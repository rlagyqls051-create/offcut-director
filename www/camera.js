'use strict';
/* camera.js — 외부 카메라 Wi-Fi 연동 레이어
 * Canon: CCAPI (REST, /ccapi/ver100/shooting/control/...)
 * Sony : Camera Remote API (JSON-RPC over HTTP, /sony/camera)
 * 네이티브(Capacitor)는 CapacitorHttp로 CORS 없이 카메라에 직통.
 * 웹 fetch 폴백은 카메라가 CORS 헤더를 안 줘서 대부분 실패 → 앱 전용 기능.
 */
const CamLink = (() => {
  const TIMEOUT = 2500;

  async function http(method, url, body, timeoutMs = TIMEOUT, extraHeaders) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
    const CH = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (CH && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      return await CH.request({
        method, url, headers,
        data: body || undefined,
        connectTimeout: timeoutMs, readTimeout: timeoutMs,
      });
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method, signal: ctl.signal, headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, data: await r.json().catch(() => null) };
    } finally { clearTimeout(t); }
  }

  /* ---------- Canon CCAPI ---------- */
  const canon = {
    // /ccapi/ver100/deviceinformation → {productname, serialnumber, firmwareversion}
    ping: ip => http('GET', `http://${ip}:8080/ccapi/ver100/deviceinformation`),
    start: async ip => {
      // 무비 모드가 아니면 recbutton이 안 먹는 기종이 있어 먼저 moviemode on
      try { await http('POST', `http://${ip}:8080/ccapi/ver100/shooting/control/moviemode`, { action: 'on' }); } catch {}
      return http('POST', `http://${ip}:8080/ccapi/ver100/shooting/control/recbutton`, { action: 'start' });
    },
    stop: ip => http('POST', `http://${ip}:8080/ccapi/ver100/shooting/control/recbutton`, { action: 'stop' }),
    // /event/polling: addedcontents(새 파일 URL) + 기종에 따라 recording 상태
    status: ip => http('GET', `http://${ip}:8080/ccapi/event/polling?continue=off`).then(r => {
      const d = (r && r.data) || {};
      let file = null;
      if (Array.isArray(d.addedcontents) && d.addedcontents.length)
        file = String(d.addedcontents[d.addedcontents.length - 1]).split('/').pop();
      return { recording: typeof d.recording === 'boolean' ? d.recording : null, file };
    }),
  };

  /* ---------- Sony Camera Remote API (JSON-RPC) ---------- */
  let sonyId = 1;
  const sonyRpc = (ip, method, params = []) =>
    http('POST', `http://${ip}:8080/sony/camera`, { method, params, id: sonyId++, version: '1.0' });
  const sony = {
    ping: ip => sonyRpc(ip, 'getAvailableApiList'),
    start: async ip => {
      // 이미 RecMode면 에러를 내는 기종 있어 무시하고 진행
      try { await sonyRpc(ip, 'startRecMode'); } catch {}
      return sonyRpc(ip, 'startMovieRec');
    },
    stop: ip => sonyRpc(ip, 'stopMovieRec'),
    // getEvent: result 배열 어딘가에 cameraStatus ('MovieRecording' 등)
    status: ip => sonyRpc(ip, 'getEvent', [false]).then(r => {
      const arr = r && r.data && r.data.result;
      let st = null;
      if (Array.isArray(arr)) for (const e of arr) { if (e && e.cameraStatus) st = e.cameraStatus; }
      return { recording: /MovieRec/i.test(st || ''), file: null };
    }),
  };

  /* ---------- BLE 공용 링크 (Sony RMT-P1BT 에뮬 / GoPro Open GoPro) ---------- */
  const blePlugin = () => {
    const P = window.Capacitor && window.Capacitor.Plugins;
    const B = P && P.BleClient;
    if (!B) throw new Error('BLE는 네이티브 앱에서만 지원됩니다');
    return B;
  };
  function makeBleLink({ match, nty, onNotify, notFoundMsg }) {
    const L = { dev: null, name: null, rec: null, connecting: null };
    L.connected = () => !!L.dev;
    L.connect = async () => {
      if (L.dev) return L.name;
      if (L.connecting) return L.connecting;
      L.connecting = (async () => {
        const B = blePlugin();
        await B.initialize();
        const found = await new Promise((resolve, reject) => {
          const to = setTimeout(() => {
            B.stopLEScan().catch(() => {});
            reject(new Error(notFoundMsg));
          }, 12000);
          B.requestLEScan({ allowDuplicates: false }, r => {
            if (!match(r)) return;
            clearTimeout(to);
            B.stopLEScan().catch(() => {});
            resolve(r.device);
          }).catch(e => { clearTimeout(to); reject(e); });
        });
        await B.connect(found.deviceId, () => { L.dev = null; L.rec = null; }); // 끊김 → 상태 리셋
        L.dev = found.deviceId;
        L.name = found.name || found.localName || 'BLE 카메라';
        try { await B.createBond(found.deviceId); } catch {} // Android 명시 본딩, iOS는 OS가 처리
        await B.startNotifications(found.deviceId, nty.svc, nty.char, v => {
          onNotify(new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength), L);
        });
        return L.name;
      })().finally(() => { L.connecting = null; });
      return L.connecting;
    };
    L.write = async (svc, ch, bytes) => {
      if (!L.dev) await L.connect();
      const dv = new DataView(bytes.length);
      bytes.forEach((b, i) => dv.setUint8(i, b));
      await blePlugin().write(L.dev, svc, ch, dv);
    };
    return L;
  }

  /* Sony BLE — RMT-P1BT 프로토콜 (Greg Leeds / coral freemote 역공학):
   * REC = 0x010E LE 토글. 노티 [0x02,code,val]: 0xD5=녹화상태(0x20=진행).
   * 스캔: 제조사데이터 0x012D + '03 00' 헤더 (카메라는 페어링 전엔 서비스 미광고). */
  const SONY_BLE = {
    svc: '8000ff00-ff00-ffff-ffff-ffffffffffff',
    cmd: '0000ff01-0000-1000-8000-00805f9b34fb',
    nty: '0000ff02-0000-1000-8000-00805f9b34fb',
  };
  const sonyBle = makeBleLink({
    match: r => {
      const dv = r.manufacturerData && (r.manufacturerData['301'] || r.manufacturerData[301]);
      if (!dv) return false;
      const b = new Uint8Array(dv.buffer, dv.byteOffset || 0, dv.byteLength);
      return b.length >= 2 && b[0] === 0x03 && b[1] === 0x00;
    },
    nty: { svc: SONY_BLE.svc, char: SONY_BLE.nty },
    onNotify: (b, L) => { if (b.length === 3 && b[0] === 0x02 && b[1] === 0xd5) L.rec = (b[2] === 0x20); },
    notFoundMsg: 'Sony 카메라를 못 찾음 — 카메라 메뉴에서 Bluetooth 리모컨/페어링을 켜주세요',
  });
  const sonyble = {
    ping: () => sonyBle.connect(),
    start: () => sonyBle.write(SONY_BLE.svc, SONY_BLE.cmd, [0x0e, 0x01]), // 0x010E 토글 — 실제 상태는 FF02 노티로 추적
    stop: () => sonyBle.write(SONY_BLE.svc, SONY_BLE.cmd, [0x0e, 0x01]),
    status: () => sonyBle.dev
      ? Promise.resolve({ recording: sonyBle.rec, file: null })
      : Promise.reject(new Error('BLE 미연결')),
    info: async () => sonyBle.dev ? { model: sonyBle.name } : {},
  };

  /* GoPro BLE — Open GoPro 공식 API (HERO9~13, MAX2):
   * 서비스 FEA6, 커맨드 b5f90072, 쿼리 b5f90076, 응답 노티 b5f90077.
   * 셔터 [03 01 01 01]=시작 / [03 01 01 00]=정지 (토글이 아니라 명시적).
   * 상태쿼리 [01 13] → 노티로 TLV [statusId,len,val] — statusId 10 = ENCODING.
   * 폴링 주기의 상태 쿼리가 GoPro의 BLE 유휴 끊김 방지(keep-alive)를 겸함. */
  const GP_BLE = {
    svc: '0000fea6-0000-1000-8000-00805f9b34fb',
    cmd: 'b5f90072-aa8d-11e3-9046-0002a5d5c51b',
    qry: 'b5f90076-aa8d-11e3-9046-0002a5d5c51b',
    nty: 'b5f90077-aa8d-11e3-9046-0002a5d5c51b',
  };
  const goproBle = makeBleLink({
    match: r => /^gopro/i.test((r.device && r.device.name) || r.localName || ''),
    nty: { svc: GP_BLE.svc, char: GP_BLE.nty },
    onNotify: (b, L) => {
      for (let i = 1; i + 2 < b.length; i++) {
        if (b[i] === 10 && b[i + 1] === 1) L.rec = !!b[i + 2]; // TLV: ENCODING 상태
      }
    },
    notFoundMsg: 'GoPro를 못 찾음 — 카메라 켜고 Connections > Connect Device 상태로 두세요',
  });
  const gopro = {
    ping: () => goproBle.connect(),
    start: () => goproBle.write(GP_BLE.svc, GP_BLE.cmd, [0x03, 0x01, 0x01, 0x01]),
    stop: () => goproBle.write(GP_BLE.svc, GP_BLE.cmd, [0x03, 0x01, 0x01, 0x00]),
    status: async () => {
      if (!goproBle.dev) throw new Error('BLE 미연결');
      try { await goproBle.write(GP_BLE.svc, GP_BLE.qry, [0x01, 0x13]); } catch {} // 상태쿼리 = keep-alive 겸용
      return { recording: goproBle.rec, file: null };
    },
    info: async () => goproBle.dev ? { model: goproBle.name } : {},
  };

  /* ---------- Insta360 OSC (공식 API — X/X2/R/RS/X3/X4/X5) ----------
   * 카메라 Wi-Fi AP 접속 → http://192.168.42.1/osc/...
   * X-XSRF-Protected 헤더 필수. stopCapture 응답의 fileUrls로 진짜 파일명 획득. */
  const OSC_H = { 'X-XSRF-Protected': '1', 'Accept': 'application/json' };
  const osc = (ip, name, parameters) =>
    http('POST', `http://${ip}/osc/commands/execute`, { name, parameters: parameters || {} }, TIMEOUT, OSC_H);
  const insta360 = {
    pendingFile: null,
    ping: ip => http('GET', `http://${ip}/osc/info`, null, TIMEOUT, OSC_H),
    start: ip => osc(ip, 'camera.startCapture'),
    stop: ip => osc(ip, 'camera.stopCapture').then(r => {
      const u = r && r.data && r.data.results && (r.data.results.fileUrls || r.data.results._localFileUrls);
      if (Array.isArray(u) && u.length) insta360.pendingFile = String(u[u.length - 1]).split('/').pop();
    }),
    status: ip => http('POST', `http://${ip}/osc/state`, null, TIMEOUT, OSC_H).then(r => {
      const st = (r && r.data && r.data.state) || {};
      let rec = null;
      if (typeof st._captureStatus === 'boolean') rec = st._captureStatus;
      else if (typeof st.isCapturing === 'boolean') rec = st.isCapturing;
      else if (typeof st.captureStatus === 'boolean') rec = st.captureStatus;
      const f = insta360.pendingFile; insta360.pendingFile = null;
      return { recording: rec, file: f };
    }),
  };

  const adapters = { canon, sony, sonyble, insta360, gopro };
  const BLE_TYPES = new Set(['sonyble', 'gopro']);
  const isBle = t => BLE_TYPES.has(t);
  const defaultIp = t => t === 'canon' ? '192.168.1.2' : t === 'sony' ? '192.168.122.1' : t === 'insta360' ? '192.168.42.1' : '';
  const cfgOf = c => ({ type: c.type || c.camType, ip: c.ip || c.camIp });
  const isLinked = c => {
    const g = cfgOf(c || {});
    if (isBle(g.type)) return true;
    return !!(g.type && g.type !== 'off' && g.ip);
  };

  async function test(c) {
    const g = cfgOf(c);
    const a = adapters[g.type];
    if (!a) throw new Error('카메라 종류/IP를 확인하세요');
    if (isBle(g.type)) {
      const name = await a.ping();
      return `${name} BLE 연결 확인`;
    }
    if (!g.ip) throw new Error('카메라 종류/IP를 확인하세요');
    const r = await a.ping(g.ip);
    const name = (r && r.data && (r.data.productname || r.data.productName || r.data.model || r.data.deviceName)) ||
      (g.type === 'sony' ? 'Sony 카메라' : g.type === 'insta360' ? 'Insta360 카메라' : 'Canon 카메라');
    return `${name} 연결 확인`;
  }

  const recStart = c => { const g = cfgOf(c); return adapters[g.type].start(g.ip); };
  const recStop = c => { const g = cfgOf(c); return adapters[g.type].stop(g.ip).then(() => true, () => false); };

  /* ---------- 카메라 상태 조회 (모델/배터리/스토리지/온도 — capability-gated) ---------- */
  async function getInfo(c) {
    const g = cfgOf(c);
    const info = {};
    if (isBle(g.type)) {
      const L = g.type === 'gopro' ? goproBle : sonyBle;
      return L.dev ? { model: L.name } : {};
    }
    if (!adapters[g.type] || !g.ip) throw new Error('카메라 종류/IP를 확인하세요');
    if (g.type === 'insta360') {
      const [inf, st] = await Promise.allSettled([
        http('GET', `http://${g.ip}/osc/info`, null, TIMEOUT, OSC_H),
        http('POST', `http://${g.ip}/osc/state`, null, TIMEOUT, OSC_H),
      ]);
      const d = (inf.value && inf.value.data) || {};
      info.model = d.model;
      info.fw = d.firmwareVersion || d.firmware;
      const s = st.value && st.value.data && st.value.data.state;
      if (s && s.batteryLevel != null) info.battery = s.batteryLevel;
      if (s && s.remainingSpace != null) info.storage = `${(s.remainingSpace / 1e9).toFixed(1)}GB 여유`;
      return info;
    }
    if (g.type === 'canon') {
      const base = `http://${g.ip}:8080/ccapi/ver100`;
      const [dev, bat, stor, temp] = await Promise.allSettled([
        http('GET', `${base}/deviceinformation`),
        http('GET', `${base}/devicestatus/battery`),
        http('GET', `${base}/devicestatus/storage`),
        http('GET', `${base}/devicestatus/temperature`),
      ]);
      const d = (dev.value && dev.value.data) || {};
      info.model = d.productname || d.productName;
      info.fw = d.firmwareversion;
      const b = (bat.value && bat.value.data) || {};
      if (b.level) info.battery = b.level + (b.name ? ` (${b.name})` : '');
      const ss = stor.value && stor.value.data && stor.value.data.storage;
      if (Array.isArray(ss)) {
        const s = ss.find(x => x.maxsize) || ss[0];
        if (s && s.maxsize) info.storage = `${(s.spacesize / 1e9).toFixed(1)}GB 여유 / 총 ${(s.maxsize / 1e9).toFixed(1)}GB${s.contentsnumber != null ? ` · ${s.contentsnumber}개 파일` : ''}`;
      }
      const t = (temp.value && temp.value.data) || {};
      if (t.status) info.temp = t.status;
    } else {
      const [sys, ev] = await Promise.allSettled([
        sonyRpc(g.ip, 'getSystemInformation'),
        sonyRpc(g.ip, 'getEvent', [false]),
      ]);
      const sd = sys.value && sys.value.data && sys.value.data.result;
      if (Array.isArray(sd) && sd[0]) info.model = sd[0].model || sd[0].modelName;
      const arr = ev.value && ev.value.data && ev.value.data.result;
      if (Array.isArray(arr)) for (const e of arr) {
        if (!e) continue;
        if (e.batteryLevelPercent) info.battery = e.batteryLevelPercent;
        if (Array.isArray(e.batteryInfo)) {
          const p = e.batteryInfo.map(x => x.batteryLevelPercent || x.levelIndicator).filter(Boolean);
          if (p.length) info.battery = p.join(' / ');
        }
      }
    }
    return info;
  }

  /* ---------- 상태 폴링 — 카메라 측 REC 시작/정지 자동 감지 ---------- */
  let pollTimer = null, pollFails = 0, lastFile = null;
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    pollFails = 0; lastFile = null;
  }
  // onEvent: {type:'state', recording:bool} | {type:'file', name} | {type:'health', ok:bool}
  function startPoll(cfg, onEvent, intervalMs = 1200) {
    stopPoll();
    const g = cfgOf(cfg || {});
    if (!g.type || g.type === 'off' || (!isBle(g.type) && !g.ip)) return;
    const tick = async () => {
      try {
        const st = await adapters[g.type].status(g.ip);
        if (pollFails) { pollFails = 0; onEvent({ type: 'health', ok: true }); }
        if (st.recording !== null && st.recording !== undefined) onEvent({ type: 'state', recording: st.recording });
        if (st.file && st.file !== lastFile) { lastFile = st.file; onEvent({ type: 'file', name: st.file }); }
      } catch {
        if (++pollFails === 3) onEvent({ type: 'health', ok: false });
      }
    };
    pollTimer = setInterval(tick, intervalMs);
  }
  const polling = () => !!pollTimer;

  return { defaultIp, isBle, isLinked, test, getInfo, recStart, recStop, startPoll, stopPoll, polling };
})();
