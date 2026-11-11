#!/usr/bin/env node
/**
 * 发布安卓客户端 / Publish the Android client.
 *
 * 把签好名的 APK 与 `apk/version.json` 发到站点桶。客户端（`UpdateManager`）
 * 只读这一个清单，所以清单里的 versionCode 必须和 APK 里的一致——两边都从
 * `android/app/version.properties` 来，别在这里另写一份。
 *
 * The APK and its manifest go to the site bucket under `apk/`. The client reads
 * that single manifest, so its versionCode must match the one baked into the
 * APK; both come from `android/app/version.properties`.
 *
 * 用法 / Usage:
 *   SITE_BUCKET=... SITE_DOMAIN=photos.example.com node scripts/publish-apk.mjs
 *   ... --apk path/to/app-release.apk   # 换一个安装包
 *   ... --notes "修了灯箱翻页"           # 更新提示里显示的说明
 *   ... --dry                           # 只打印要执行的命令
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = path.join(ROOT, 'android/app/version.properties');
const DEFAULT_APK = path.join(ROOT, 'android/app/build/outputs/apk/release/app-release.apk');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
}

const DRY = process.argv.includes('--dry');

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** 读 version.properties。只认 key=value，不引依赖。 */
function readVersion() {
  if (!existsSync(VERSION_FILE)) fail(`找不到 ${path.relative(ROOT, VERSION_FILE)}`);
  const map = new Map();
  for (const line of readFileSync(VERSION_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at > 0) map.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim());
  }
  const versionCode = Number(map.get('versionCode'));
  const versionName = map.get('versionName');
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    fail('android/app/version.properties 里的 versionCode 不是正整数');
  }
  if (!versionName) fail('android/app/version.properties 里缺 versionName');
  return { versionCode, versionName };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function run(args) {
  const pretty = args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ');
  if (DRY) {
    console.log(`  aws ${pretty}`);
    return;
  }
  execFileSync('aws', args, { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------

const bucket = process.env.SITE_BUCKET ?? '';
const domain = (process.env.SITE_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-1';
const distributionId = process.env.DISTRIBUTION_ID ?? '';

if (!bucket) fail('缺 SITE_BUCKET（站点桶名）');
if (!domain) fail('缺 SITE_DOMAIN（对外域名，用来拼清单里的下载地址）');

const { versionCode, versionName } = readVersion();
const apkPath = path.resolve(arg('apk', DEFAULT_APK));
const notes = arg('notes', '');

if (!existsSync(apkPath)) {
  fail(`找不到安装包 ${apkPath}\n  先构建：cd android && ./gradlew assembleRelease`);
}
if (apkPath.endsWith('-unsigned.apk')) {
  fail('这是未签名的包，装不上。先生成 keystore 再 assembleRelease（见 android/README 说明）');
}

const size = statSync(apkPath).size;
if (size < 64 * 1024) fail(`安装包只有 ${size} 字节，不像正常产物`);
const digest = sha256(apkPath);

const apkKey = `apk/album-${versionCode}.apk`;
const manifestKey = 'apk/version.json';
const apkUrl = `https://${domain}/${apkKey}`;

const manifest = {
  versionCode,
  versionName,
  url: apkUrl,
  sha256: digest,
  ...(notes ? { notes } : {}),
};

console.log(`\n${DRY ? '（预演，不会真的上传）' : ''}`);
console.log(`  版本 / version : ${versionName} (${versionCode})`);
console.log(`  安装包 / apk   : ${path.relative(ROOT, apkPath)}  ${(size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  sha256        : ${digest}`);
console.log(`  地址 / url     : ${apkUrl}\n`);

// APK 文件名带 versionCode，内容永不变，可以放心长缓存。
// 清单必须每次都是最新，否则「点了更新却下到旧包」。
// The APK name carries versionCode and never changes, so cache it hard. The
// manifest must always be fresh, or clients download a stale APK.
console.log('1/3 上传安装包 / upload apk');
run([
  's3', 'cp', apkPath, `s3://${bucket}/${apkKey}`,
  '--region', region,
  '--content-type', 'application/vnd.android.package-archive',
  '--cache-control', 'public, max-age=31536000, immutable',
]);

console.log('2/3 上传清单 / upload manifest');
const tmpManifest = path.join(ROOT, 'apk-out', 'version.json');
if (!DRY) {
  mkdirSync(path.dirname(tmpManifest), { recursive: true });
  writeFileSync(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`);
}
run([
  's3', 'cp', tmpManifest, `s3://${bucket}/${manifestKey}`,
  '--region', region,
  '--content-type', 'application/json; charset=utf-8',
  '--cache-control', 'no-cache, must-revalidate',
]);

if (distributionId) {
  // 只失效清单：APK 是内容寻址的，换版本就是换文件名
  console.log('3/3 失效清单缓存 / invalidate manifest');
  run([
    'cloudfront', 'create-invalidation',
    '--distribution-id', distributionId,
    '--paths', `/${manifestKey}`,
  ]);
} else {
  console.log('3/3 跳过 CDN 失效（未提供 DISTRIBUTION_ID）');
}

console.log(`\n✓ 已发布 ${versionName} (${versionCode})${DRY ? '（预演）' : ''}\n`);
