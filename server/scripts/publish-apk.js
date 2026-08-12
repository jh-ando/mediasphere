#!/usr/bin/env node
// MediaSphere - APK 배포 준비 스크립트
//
// APK 파일 하나를 받아서 versionCode/versionName을 추출하고, server/apk/에
// 버전이 포함된 이름으로 정리해 복사한 뒤 server/data/app-version.json을 갱신한다.
// 서버(server.js)는 이 두 산출물(apk/, app-version.json)을 읽기만 한다 -
// 실제로 폰에 발행하는 건 서버가 뜬 상태에서 POST /api/app-deploy를 호출해야 한다.
//
// 사용법:
//   node scripts/publish-apk.js <apk-path>
//   npm run publish-apk -- <apk-path>

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AppInfoParser = require('app-info-parser');

const APK_DIR = path.join(__dirname, '..', 'apk');
const APK_VERSION_PATH = path.join(__dirname, '..', 'data', 'app-version.json');
const EXPECTED_PACKAGE = 'com.mediasphere.client';

function sha256Of(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readExistingVersion() {
  if (!fs.existsSync(APK_VERSION_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(APK_VERSION_PATH));
  } catch (err) {
    return null;
  }
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('사용법: node scripts/publish-apk.js <apk-path>');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`[!] 파일 없음: ${inputPath}`);
    process.exit(1);
  }

  const parser = new AppInfoParser(inputPath);
  const info = await parser.parse();
  const { versionCode, versionName, package: packageName } = info;

  if (!versionCode || !versionName) {
    console.error('[!] versionCode/versionName을 읽지 못했습니다 - 올바른 APK인지 확인하세요.');
    process.exit(1);
  }
  if (packageName !== EXPECTED_PACKAGE) {
    console.error(`[!] package명이 다릅니다 (${packageName}, 기대값: ${EXPECTED_PACKAGE}) - `
      + '다른 앱의 APK가 아닌지 확인하세요.');
    process.exit(1);
  }

  const existing = readExistingVersion();
  if (existing && versionCode <= existing.versionCode) {
    console.warn(`[!] 경고: 새 versionCode(${versionCode})가 기존(${existing.versionCode})보다 `
      + '크지 않습니다. 폰들은 다운그레이드를 거부하므로 실제로는 업데이트되지 않습니다.');
  }

  fs.mkdirSync(APK_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(APK_VERSION_PATH), { recursive: true });

  const fileName = `mediasphere-v${versionCode}.apk`;
  const destPath = path.join(APK_DIR, fileName);
  fs.copyFileSync(inputPath, destPath);

  const versionInfo = {
    versionCode,
    versionName,
    fileName,
    sha256: `sha256:${sha256Of(destPath)}`,
    uploadedAt: new Date().toISOString(),
  };
  fs.writeFileSync(APK_VERSION_PATH, JSON.stringify(versionInfo, null, 2));

  console.log(`[OK] ${destPath}`);
  console.log(`[OK] ${APK_VERSION_PATH} 갱신 - versionCode=${versionCode} versionName=${versionName}`);
  console.log('[i] 서버가 실행 중이면 POST /api/app-deploy 호출해서 폰에 발행하세요');
}

main().catch((err) => {
  console.error('[!] 실패:', err.message);
  process.exit(1);
});
