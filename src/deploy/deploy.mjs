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
  // 产物文件名带内容哈希，同尺寸即同内容；本地每次构建都会刷新 mtime，
  // 不加这个的话每轮都会把十几个没变的文件重传一遍。
  // 无哈希的 index.html 与 version.json 由下面对 cp 单独覆盖，不受影响。
  '--size-only',
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

/**
 * 部署后自检：直接问一次线上，确认入口页与它引用的资源都真的可取。
 * 用分发域名（DNS 未生效时也可用），避免把「DNS 没配好」误判成「部署失败」。
 */
async function smoke() {
  const origin = state.distributionDomainName
    ? `https://${state.distributionDomainName}`
    : config.siteUrl;

  // 不要加查询串：桶策略只给了 GetObject，`/?x=1` 会被 S3 当成 ListBucket 请求而 403
  const page = await fetch(`${origin}/`, { cache: 'no-store' });
  if (!page.ok) throw new Error(`入口页返回 ${page.status}`);
  const html = await page.text();

  const asset = /(?:src|href)="(assets\/[^"]+)"/.exec(html)?.[1];
  if (!asset) throw new Error('入口页里找不到 assets/ 引用');
  if (!html.includes('__MANIFEST__') && !/data\/manifest\.[0-9a-f]+\.json/.test(html)) {
    throw new Error('入口页没有指向 manifest');
  }

  const assetRes = await fetch(`${origin}/${asset}`, { method: 'HEAD' });
  if (!assetRes.ok) throw new Error(`${asset} 返回 ${assetRes.status}`);

  const versionRes = await fetch(`${origin}/data/version.json`, { cache: 'no-store' });
  if (!versionRes.ok) throw new Error(`version.json 返回 ${versionRes.status}`);
  const version = await versionRes.json();
  if (!version.rev) throw new Error('version.json 缺少 rev');

  console.log(`线上自检通过：${origin}（入口 ${asset} / rev ${version.rev}）`);
  return { origin, asset, rev: version.rev };
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

  // 失效还在传播时首次自检可能读到旧入口，重试几次即可
  let smokeResult = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      smokeResult = await smoke();
      break;
    } catch (err) {
      if (attempt === 4) {
        report.smoke = { ok: false, error: err.message };
        await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
        throw new Error(`线上自检失败：${err.message}`);
      }
      console.log(`自检第 ${attempt} 次未通过（${err.message}），20s 后重试`);
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
  }
  report.smoke = { ok: true, ...smokeResult };
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
