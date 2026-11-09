import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DIST, DRY_RUN, loadConfig, loadState, run, selfCheck } from './aws.mjs';

const config = await loadConfig();
const state = await loadState();
const REPORT = path.join(DIST, '.build-report.json');
const BUCKET = `s3://${config.bucket}/`;

/**
 * 缓存头两段式（plan §10.1）：
 *   1) 先整目录 sync --delete，全部打长缓存（产物文件名都带内容哈希）
 *   2) 再单独 cp 覆盖入口页与版本文件为不缓存
 * 不能用 --exclude 把入口页排除在 sync 之外——--exclude 会连带影响 --delete 的判定，
 * 让入口页被当成「源站已不存在」而删掉。
 */
const LONG_CACHE = 'public, max-age=31536000, immutable';
const HTML_CACHE = 'no-cache, must-revalidate';
const VERSION_CACHE = 'no-store, no-cache, must-revalidate';

const syncArgs = [
  's3', 'sync', DIST, BUCKET,
  '--region', config.region, '--delete',
  '--exclude', '.build-report.json',
  '--cache-control', LONG_CACHE,
];

const META_FILES = [
  { rel: 'index.html', type: 'text/html; charset=utf-8', cache: HTML_CACHE },
  { rel: 'data/version.json', type: 'application/json', cache: VERSION_CACHE },
];

function cpArgs(file) {
  return [
    's3', 'cp', path.join(DIST, file.rel), `${BUCKET}${file.rel}`,
    '--region', config.region,
    '--cache-control', file.cache,
    '--content-type', file.type,
    '--metadata-directive', 'REPLACE',
  ];
}

const invalidationArgs = [
  'cloudfront', 'create-invalidation',
  '--distribution-id', state.distributionId || '<DISTRIBUTION_ID>',
  '--paths', '/index.html', '/data/version.json',
];

function printPlan() {
  console.log('--- 日常发布计划（dry-run，不接触 AWS）---');
  console.log(`桶         : ${config.bucket} (${config.region})`);
  console.log(`分发 ID    : ${state.distributionId || '尚未初始化'}`);
  console.log(`正式地址   : ${config.siteUrl}`);
  console.log('');
  console.log('  aws --version');
  console.log(`  aws sts get-caller-identity --region ${config.region}`);
  console.log(`  # 第一段：全量长缓存`);
  console.log(`  aws s3 sync ${DIST} ${BUCKET} --region ${config.region} --delete --exclude .build-report.json --cache-control "${LONG_CACHE}"`);
  console.log('  # 第二段：入口页与版本文件改为不缓存');
  for (const file of META_FILES) {
    console.log(`  aws s3 cp ${file.rel} ${BUCKET}${file.rel} --cache-control "${file.cache}" --metadata-directive REPLACE`);
  }
  console.log(`  aws cloudfront create-invalidation --distribution-id ${state.distributionId || '<ID>'} --paths /index.html /data/version.json`);
  console.log('  回写 dist/.build-report.json 的 invalidation 字段');
  console.log('');
  console.log('未执行任何 AWS 操作。去掉 --dry-run 即会真实部署。');
}

async function main() {
  if (DRY_RUN) {
    printPlan();
    return;
  }

  selfCheck(config);
  if (!state.distributionId) {
    throw new Error('尚未初始化 CloudFront 分发。请先运行 npm run deploy:init 完成首次引导。');
  }

  const preview = run([...syncArgs, '--dryrun'], { allowFail: true });
  const deletions = (preview.stdout.match(/delete:/g) || []).length;
  console.log(`同步预览：将删除 ${deletions} 个旧对象。`);

  const sync = run(syncArgs);
  const uploads = (sync.stdout.match(/upload:/g) || []).length;
  console.log(`第一段完成：已同步 dist/，上传 ${uploads} 个对象（长缓存）。`);

  for (const file of META_FILES) {
    run(cpArgs(file));
    console.log(`第二段完成：${file.rel} → ${file.cache}`);
  }

  const invalidation = run(invalidationArgs);
  const detail = invalidation.json?.Invalidation || {};
  console.log(`缓存失效已提交：${detail.Id || '(无 Id)'} / ${detail.Status || 'unknown'}`);

  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  report.cacheControl = { assets: LONG_CACHE, ...Object.fromEntries(META_FILES.map((f) => [f.rel, f.cache])) };
  report.invalidation = {
    executed: true,
    paths: ['/index.html', '/data/version.json'],
    id: detail.Id || null,
    status: detail.Status || 'Completed',
  };
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);

  console.log('');
  console.log('--- 部署完成 ---');
  console.log(`新增 ${report.added} / 跳过 ${report.skipped} / 删除 ${deletions} / 失效 ${report.invalidation.paths.length} 个路径`);
  console.log(`访问地址：${config.siteUrl}`);
}

main().catch((err) => {
  console.error(`部署失败：${err.message}`);
  process.exitCode = 1;
});
