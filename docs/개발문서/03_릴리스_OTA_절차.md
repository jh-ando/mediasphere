# 03. 릴리스·OTA 절차

> 앱(APK)을 새로 빌드해 439대에 무선으로 업데이트하는 절차입니다.
> 서버 코드 업데이트는 [02_설치_구축_런북](02_설치_구축_런북.md) 2.5를 보세요.

---

## 1. 동작 원리

```
빌드(PC) → publish-apk.js(서버: apk/ 복사 + data/app-version.json 갱신)
        → POST /api/app-deploy → MQTT wall/ota (retain) {versionCode, url, sha256, startAt, stepDelayMs}
        → 폰: 자기 차례까지 대기 → URL 호스트 확인 → 다운로드(재시도 4회) → SHA-256 확인
          → PackageInstaller 무인 설치(Device Owner) → MY_PACKAGE_REPLACED → 앱 재실행
        → wall/ota/status/{id}: downloading → installing → done | failed(+reason)
```

- **롤링 배포**: 폰마다 `startAt + (deviceId-1) × stepDelayMs`에 시작합니다. 기본 `stepDelayMs`는 200ms이므로 439대 전체가 약 88초에 걸쳐 나뉘어 시작됩니다.
- **retain 발행**: 꺼져 있던 폰도 다시 접속하면 업데이트를 받습니다.
- **다운그레이드 거부**: 폰은 `versionCode`가 현재보다 크지 않으면 무시합니다. 같은 번호로 다시 빌드하면 **아무 일도 일어나지 않습니다**.
- **URL 호스트 확인**: 메시지의 APK 주소 호스트가 폰 config의 `serverIp`와 다르면 `URL_HOST_MISMATCH`로 실패합니다(인증이 없어 최소한의 방어로 넣은 확인).
- 실패해도 기존 앱은 그대로 유지됩니다.

---

## 2. 사전 준비 (한 번만)

### 2.1 release 서명 키 ⚠ 가장 중요

- `android/keystore.properties`(커밋 안 됨)와 `mediasphere-release.jks`가 있어야 release APK가 서명됩니다. 형식은 `android/keystore.properties.example`을 참고하세요.
- ⚠ **키를 잃어버리면 이미 설치된 439대에 다시는 OTA를 할 수 없습니다.** 서명이 다르면 Android가 설치를 거부합니다(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). 그때는 폰을 하나씩 초기화하고 재설치해야 합니다.
- 📝 keystore 원본과 비밀번호의 보관 위치(최소 2곳)를 [00_인수인계_요약](00_인수인계_요약.md)에 기록하세요. 비밀번호 자체는 문서에 적지 않습니다.

### 2.2 빌드 환경
- Android Studio(번들 JBR). 명령줄로 빌드할 때는 `JAVA_HOME`을 Android Studio의 `jbr` 폴더로 지정합니다.
- compileSdk 37, targetSdk 36, minSdk 29

---

## 3. 릴리스 절차

### ① 버전 올리기
`android/app/build.gradle.kts`의 `defaultConfig`:
```kotlin
versionCode = 30        // 반드시 이전보다 큰 정수
versionName = "2.8"     // 사람이 보는 이름
```
> 현재 관례: 버전 변경은 로컬에서 하고 **기능 커밋에는 포함하지 않습니다**. 버전만 따로 `chore:` 커밋으로 남길지는 담당자가 정합니다.
> 📝 지금까지 배포한 버전 이력은 4장 표에 계속 추가합니다.

### ② release 빌드
```bash
cd android
./gradlew assembleRelease
# 결과: android/app/build/outputs/apk/release/app-release.apk
```
빌드 로그에 `keystore.properties 없음` 경고가 나오면 서명이 안 된 것이므로 배포하면 안 됩니다.

### ③ 사전 시험 (권장)
- 현장 폰 1~2대(또는 에뮬레이터)에 `adb install -r app-release.apk`로 먼저 설치해 기본 동작을 확인합니다.
- 큰 변경이면 [06_테스트_가이드](06_테스트_가이드.md)의 에뮬레이터 E2E를 돌립니다.

### ④ 서버에 올리기
```bash
scp android/app/build/outputs/apk/release/app-release.apk mediasphere@192.168.8.10:/tmp/
# 서버에서
cd /home/mediasphere/MediaSphere/server
node scripts/publish-apk.js /tmp/app-release.apk
```
패키지명과 versionCode를 확인한 뒤 `server/apk/mediasphere-v{versionCode}.apk`로 복사하고, `server/data/app-version.json`을 갱신합니다.

### ⑤ 배포 발행
```bash
curl -X POST http://192.168.8.10:3000/api/app-deploy \
  -H 'Content-Type: application/json' -d '{"stepDelayMs":200}'
```
⚠ **반드시 서버 IP(`192.168.8.10`)로 호출하세요.** APK 주소가 요청한 호스트로 만들어지기 때문에, `localhost`로 호출하면 폰이 전부 `URL_HOST_MISMATCH`로 실패합니다.

### ⑥ 진행 확인
- 대시보드 상단 OTA 현황(대기/다운/설치/완료/실패)과 [앱 버전] 카드의 버전 분포를 봅니다.
- 실패 사유 원문: `mosquitto_sub -h localhost -t 'wall/ota/status/#' -v`
- 완료되면 폰 heartbeat의 `versionCode`가 새 값으로 바뀌고, "최근 재시작" 기록에 의도한 종료(UPDATE)로 남습니다.

### ⑦ 마무리
- 버전이 다른 폰이 남아 있으면 → 5장
- 운영 시간 중에는 배포하지 마세요. 설치 순간 앱이 다시 시작되면서 화면이 잠깐 꺼집니다.

---

## 4. 버전 이력

| versionCode | versionName | 주요 변경 | 커밋 |
|---|---|---|---|
| 9 | 1.8 | 텍스트 패턴 | `e29121a` |
| 19 | 2.41 | PLAY_TRIGGER 크로스페이드 | `51345e0` |
| 23 | 2.53 | 동기화 코루틴 크래시 수정 | `e0eac4c` |
| 27 | 2.61 | 키오스크 해제 5번 탭 | `a8d69f9` |
| 29 | 2.7 | (로컬 작업 중 값) 디코더 대응·자동 복구·발열 보고 등 | `e191745`~`8b464d7` |

> 📝 실제로 현장에 배포한 버전과 날짜를 여기에 이어서 적어 주세요. 위 표는 커밋 기록에서 확인할 수 있는 값만 옮긴 것입니다.

---

## 5. 문제 해결

| 증상(`reason`) | 원인 | 조치 |
|---|---|---|
| 아무 반응 없음 | versionCode가 같거나 낮음 | ①부터 다시 |
| `URL_HOST_MISMATCH` | `localhost`로 app-deploy 호출, 또는 폰 config의 serverIp가 다름 | 서버 IP로 다시 호출 |
| `DOWNLOAD_FAILED` | Wi-Fi 혼잡, 서버 `/apk` 접근 불가 | 혼잡이 끝난 뒤 app-deploy 재호출(완료된 폰은 무시함) |
| 설치 확인 팝업이 뜨고 멈춤 | 그 폰이 Device Owner가 아님 | 현장에서 [설치]를 누르고, 이후 Device Owner로 재세팅 |
| `failed` + 서명 관련 | 다른 키로 서명됨(디버그 APK 등) | 올바른 release 키로 다시 빌드. 이미 디버그 APK가 깔린 폰은 수동 재설치 |
| 설치 후 앱이 안 뜸 | (드묾) 홈 고정 적용 직후 | 원격 재부팅 1회. 1분 생존 알람이 1~2분 안에 복구하는지도 확인 |

### 홈 고정이 처음 들어가는 버전을 배포할 때
자동 복구(홈 앱 고정) 기능이 처음 들어가는 업데이트 뒤에는 **원격 재부팅을 한 번** 하는 것을 권장합니다. 원래 런처를 홈 목록에서 정리하기 위해서입니다. 재부팅하지 않아도 생존 알람이 1~2분 안에 복구합니다.
