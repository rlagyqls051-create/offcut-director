# offcut — 1인 촬영 + 테이크 로거

소규모 촬영(인터뷰·1인 크리에이터 셀프촬영)에서 **롤 타임코드 + 구간 판정 + 메모**를 기록하고,
결과를 **프리미어 프로로 바로 넘기는** 앱. Capacitor 기반 iOS/Android 앱 퍼스트,
PWA(https://offcut-xi.vercel.app)는 같은 코드로 유지.

## 두 모드

헤더의 모드 버튼으로 원탭 전환 (롤 중엔 잠김).

- **폰 촬영 모드** (`mode: 'shoot'`) — 앱 안에서 `getUserMedia`+`MediaRecorder`로 직접 녹화.
  ROLL이 녹화 시작과 프레임 정확히 일치 → 슬레이트/릴링크 추측 불필요. 파일명 = 로그의 `fname`.
  전/후면 전환, 세로 9:16·가로 16:9, **카운트다운**(3/5/10초) 지원. 촬영 모드에선 화면 안 꺼짐.
  수 분 단위 테이크용 (긴 롤은 WebView 녹화 한계로 카메라 로거 모드 권장).
  iOS: `video/mp4`(H.264+AAC). Android/기타: mimeType 자동 감지, `video/webm` 폴백.
  앱 재시작으로 끊긴 롤은 녹화 없이 로깅만 이어감 (테이크에 '녹화실패' 대신 중단 처리).
- **카메라 로거 모드** (`mode: 'log'`) — Sony/Canon 등 외부 카메라 촬영 + 폰으로 로깅.
  카메라 파일명 패턴(`prefix`+번호)으로 FCPXML 릴링크.

### 카메라 연동 (`camType`) — ROLL/CUT에 REC 자동 연동

설정 → 카메라 연동에서 Canon(CCAPI)/Sony(Remote API) 선택 + 카메라 IP 입력.
폰이 카메라의 Wi-Fi AP에 붙어 있으면 ROLL→REC start, CUT→REC stop이 자동으로 날아감.
슬레이트 없이 파일 경계 = 로그 경계가 정확히 일치.

- **Canon CCAPI**: `POST /ccapi/ver100/shooting/control/moviemode` + `recbutton`. 기본 IP `192.168.1.2`
- **Sony 구형 Remote API**: JSON-RPC `startRecMode`→`startMovieRec`/`stopMovieRec` (포트 8080). 기본 IP `192.168.122.1`
  (α7/α9/α6x00 등 스마트 리모컨 내장 기종)
- **Sony 신형 BLE** (`sonyble`): RMT-P1BT 리모컨 프로토콜 에뮬레이션 — A7M4/A7S3/ZV-E1/FX3 등
  Wi-Fi Remote API 없는 신형 대상. 서비스 `8000FF00`, REC 토글 `0x010E`, 상태 노티 `0xD5`.
  카메라 메뉴에서 "Bluetooth 리모컨"을 켜고 첫 연결 시 OS 페어링 필요. Wi-Fi 불필요.
  주의: REC는 토글이라 카메라 상태와 어긋날 수 있음 → FF02 `0xD5` 노티로 실제 녹화상태 추적
  (카메라 본체 REC 버튼도 감지 → 자동 롤/컷 동작). 파일명 자동매핑은 Wi-Fi 경로만 지원 — BLE는 카메라 설정에서 파일명 규칙 맞춰둘 것.
  참고 구현: coral/freemote, Greg Leeds RMT-P1BT 역공학
- **Insta360 (공식 OSC)**: 카메라 Wi-Fi AP(`192.168.42.1`)에 `camera.startCapture`/`stopCapture` —
  ONE X/X2, ONE R/RS, X3/X4/X5 등 지원. `X-XSRF-Protected` 헤더 필수.
  stopCapture 응답의 `fileUrls`로 진짜 파일명 자동 매핑, `/osc/state`로 녹화상태·배터리·저장공간 폴링.
- **GoPro BLE** (`gopro`): 공식 Open GoPro API — HERO9~13, MAX2 등.
  서비스 `FEA6`, 셔터 `03 01 01 01/00` (시작/정지 명시적 — 토글 아님), 상태쿼리 `01 13`으로
  ENCODING(statusId 10) 수신 → 카메라 본체 셔터도 자동 롤/컷. 폴링 쿼리가 BLE keep-alive 겸용.
  카메라에서 Connections > Connect Device(또는 페어링) 상태로 두고 테스트 버튼으로 스캔.
  파일명 자동매핑은 미지원 — 카메라 파일명 규칙(GX01xxxx 등) 참고.
- **미지원**: DJI Osmo Pocket/Action — 공식 SDK 없음. 커뮤니티 역공학(lib-osmo-ble, osmosis)은
  페어링·텔레메트리·미디어 목록까지지만 녹화 REC 커맨드는 미확인 → 수동 로깅 모드로 사용.
- 네이티브 앱은 `CapacitorHttp`로 CORS 없이 직통. 웹(PWA)은 CORS 때문에 연동 불가 — 앱 전용
- 연동 실패해도 로깅은 항상 진행 (알림만)
- **카메라 상태 폴링 (1.2초)**: 연동된 로거 모드에서 자동 동작
  - 카메라에서 REC 버튼을 직접 눌러도 앱이 자동으로 롤 시작/컷 오픈 — 손을 안 쓰는 촬영
  - Canon `addedcontents` 이벤트로 **카메라가 만든 진짜 파일명 자동 매핑** — 파일명 추측 불필요
  - 헤더의 링크 점: 초록=폴링 정상, 빨강=응답 없음 3회 (Wi-Fi 끊김 등), 회색=대기
  - 한계: REC 시작 감지는 폴링 주기만큼 지연될 수 있고 (로그 시작이 파일보다 늦음 → 오프셋은 안전),
    Canon `recording` 필드는 기종/펌웨어 의존 — 안 나오는 기종은 파일 이벤트만 동작
  - Sony `getEvent`는 구형 Remote API 모델 기준 — 신형은 기종별 확인 필요

## 사용 흐름

1. `ROLL` — (shoot 모드: 녹화 시작 / log 모드: 화면 플래시 + 1kHz 삑)
2. 롤 도중 `채택 / 보류 / 버림` — "마지막 마크 ~ 지금" 구간을 판정하고 새 구간 시작
   - `↩ 직전 구간 판정 취소` 있음
   - 메모 입력바 — 지문/내용을 채팅처럼 기록, 타임스탬프 자동
3. `CUT` — 마지막 구간 판정 + 노트 → 테이크 저장 (shoot 모드: 클립 파일도 함께 저장)
4. 테이크 행 `▶` 클립 재생 / `⇪` 클립 공유 (녹화된 테이크만)
5. `보내기` — FCPXML / FCPXML 선택본 / SRT / CSV / EDL(DaVinci) / AI JSON / OTIO / 클립 전체 공유 / 프로젝트 패키지(.zip = 클립+로그 파일 전부)

## 리모컨/키보드 (롤 중 폰을 못 만질 때)

발표용 블루투스 클리커가 그대로 판정 리모컨이 됨:

| 키 | 동작 |
|---|---|
| `PageDown` · `→` | 채택 |
| `↑` | 보류 |
| `PageUp` · `←` | 버림 |
| `↓` · `Backspace` | 직전 구간 취소 |
| `Enter` | ROLL (스탠바이) / 판정시트에서 채택 |
| `Space` | CUT (롤 중) |
| `Esc` | 시트 닫기 |

## 프리미어 연동

- **FCPXML**: 테이크를 구간별 `asset-clip`으로 쪼개서 보냄 (`T01.1 버림`, `T01.2 채택`…).
  "버림" 구간엔 전체 길이 `버림 - 삭제` 마커, 메모는 포인트 마커.
- **SRT**: 메모를 자막으로. 익스포트된 시퀀스 타임라인 기준 TC.
- **CSV**: 구간/메모 포함 플랫 로그.
- **EDL** (CMX3600): DaVinci Resolve용. 구간별 이벤트 + `* FROM CLIP NAME` + LOC 마커(OK=GREEN/KEEP=YELLOW/NG=RED).
- **AI 편집용 JSON**: 판정/구간/메모를 구조화 — AI 편집 도구가 파싱할 수 있는 컷리스트.
  ```json
  { "project", "fps", "takes": [{ "take", "file", "verdict": "OK|KEEP|NG",
      "start_wallclock", "duration_ms",
      "sections": [{"start_ms","end_ms","verdict"}],
      "memos": [{"ms","text"}], "note", "clip_recorded" }] }
  ```
- **FCPXML 선택본**: `버림` 구간을 뺀 클린 컷리스트 — AI 컷편/빠른 1차 편집용.
- **OTIO** (OpenTimelineIO): 표준 교환 포맷 — Resolve/Premiere 플러그인, AI 파이프라인 입력용.
- **프로젝트 패키지 (.zip)**: STORE 방식 순수 JS zip — 클립 + fcpxml + srt + csv + json + edl + otio 한 파일로 편집자 전달.
- 구간 경계 사후 보정: 테이크 행의 `◂0.5` `0.5▸` 버튼으로 구간 경계를 ±0.5초 조정.

## 파일

| 파일 | 역할 |
|---|---|
| `www/` | Capacitor webDir — 웹 자산 전부 |
| `www/index.html` | 전체 마크업 (시트 4개: 판정/보내기/설정/플레이어) |
| `www/app.js` | 상태 + 로직 + 보내기 + 키매핑. 프레임워크 없음, 바닐라 |
| `www/capture.js` | 녹화/클립저장/공유 추상화 — 네이티브(Filesystem·Share) vs 웹(IndexedDB·Web Share) 자동 분기 |
| `www/style.css` | 다크 모바일 UI |
| `capacitor.config.json` | `appId: com.offcut.app`, `webDir: www` |
| `ios/`, `android/` | 네이티브 프로젝트 (Capacitor 8, iOS는 SPM) |
| `vercel.json` | `/→/www/` 리라이트 (PWA 배포 유지용) |

## 데이터 모델 (localStorage `offcut.v1`)

```js
S = {
  project, fps, prefix, startNo, slate, sound,
  mode,               // 'log' | 'shoot'
  facing,             // 'environment' | 'user'
  videoOrient,        // 'landscape' | 'portrait'
  countdownSec,       // 0|3|5|10
  camType,            // 'off' | 'canon' | 'sony' — 외부 카메라 Wi-Fi 연동
  camIp,
  takes: [{ num, fname, startMs, endMs, status,
            sections, memos, note,
            clip }],  // clip: null | 'rec' | 'failed' | {mime, size}
  seq, cur,
}
```

- 클립 파일: 네이티브 `Documents/clips/<fname>` (iOS 파일 앱에서 보임) / 웹 IndexedDB `offcut-clips`
- 시간은 `Date.now()`(벽시계) 기준 — 앱 재시작해도 유지
- 상태 변경 지점은 전부 `save()` 호출 — 직접 필드 바꾸면 유실됨

## 개발 / 빌드

```bash
# 웹 로컬 테스트
cd www && python3 -m http.server 8321

# 네이티브
npm install          # 최초 1회
npx cap sync         # www 변경사항을 ios/android에 복사
npx cap open ios     # Xcode (iOS 빌드·실기기 실행)

# 카메라 없이 연동 테스트
node tools/mockcam.js        # 가짜 Canon+Sony 카메라 (포트 8080, CORS 허용)
node tools/testcam.js        # 어댑터 헤드리스 테스트 14종
node tools/e2e.js            # 실제 app.js E2E — 자동롤/파일명매핑/판정/export 18종
#   제어판: GET http://127.0.0.1:8080/control?rec=on|off  (카메라 측 REC 시뮬레이션)
#   브라우저에서도 가능: 설정 → 카메라 연동 Canon, IP = 127.0.0.1
npx cap open android # Android Studio 필요

# 배포 (PWA)
vercel --prod --name offcut
```

### 실기기 확인 필요 사항

- Android WebView의 `MediaRecorder` API 지원 여부 (권한 처리는 Capacitor `BridgeWebChromeClient`가 자동 처리함을 소스로 확인 — manifest의 CAMERA/RECORD_AUDIO만 있으면 됨)
- iOS 롱테이크 녹화 안정성 — 문제 시 녹화만 AVFoundation 네이티브 플러그인으로 교체 가능 (capture.js 경계는 유지)
- `com.offcut.app` 번들 ID는 본인 것으로 변경

### 출시 체크리스트

- [x] iOS 카메라/마이크 권한 문구 (Info.plist)
- [x] iOS 프라이버시 매니페스트 `PrivacyInfo.xcprivacy` (FileTimestamp·UserDefaults — App Store 필수)
- [x] 앱 아이콘 + 스플래시 양 플랫폼 (`npx @capacitor/assets generate` — `assets/` 소스에서 재생성 가능)
- [x] Android 매니페스트 권한 + FileProvider 공유 경로
- [ ] Apple Developer / Google Play 계정
- [ ] App Store용 번들 ID·앱 카테고리·스크린샷·개인정보 라벨 (영상 촬영 데이터 기기 내 저장, 외부 전송 없음)
- [ ] Android Studio 설치 후 `npx cap open android`로 빌드 확인

## 카메라 연동 구현 상태

- **Canon CCAPI**: `moviemode`/`recbutton` REC 제어 + `/event/polling` 상태 폴링 구현됨.
  기종/펌웨어별 `recording` 필드 유무와 `addedcontents` 이벤트는 실기 확인 필요.
- **Sony 구형 Remote API**: JSON-RPC REC 제어 + `getEvent` `cameraStatus` 폴링 구현됨.
  스마트 리모컨 내장 기종(A7M3 등) 대상.
- **Sony 신형 BLE**: RMT-P1BT 프로토콜 에뮬레이션 구현됨 (`@capacitor-community/bluetooth-le`).
  REC 토글 + 녹화상태 노티(0xD5) 기반 자동 롤/컷. 페어링·실카메라 검증 필요 —
  기종별로 `Bluetooth 리모컨` 메뉴 유무와 노티 동작이 다를 수 있음.
- **GoPro BLE**: Open GoPro 공식 프로토콜 구현됨 — 명시적 셔터(시작/정지 구분) +
  ENCODING 상태쿼리 기반 자동 롤/컷. HERO9~13·MAX2 대상. 실기 검증 필요 —
  노티 TLV 파싱은 사양서 기준이라 기종별 확인 권장.
- 향후: Sony/Canon 자동 발견(SSDP/검색), 라이브뷰, 멀티 카메라, 신형 Sony PC브릿지(CrSDK).

## 다음에 할 만한 것

- 녹화의 네이티브화 (AVFoundation) — 롱테이크·품질 제어용. 단, AVFoundation이 카메라를 점유하면 getUserMedia 프리뷰와 충돌 → 네이티브 프리뷰 레이어 필요해 구조 변경 큼. MediaRecorder 한계가 실측으로 확인될 때 진행 권장
- 테이크별 음성 메모 녹음
- 세션/날짜별 로그 분리
