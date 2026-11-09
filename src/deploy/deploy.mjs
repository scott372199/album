import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DIST, DRY_RUN, loadConfig, loadState, run, selfCheck } from './aws.mjs';

const config = await loadConfig();
const state = await loadState();
const REPORT = path.join(DIST, '.build-report.json');

const syncArgs = [
  's3', 'sync', DIST, `s3://${config.bucket}/`,
  '--region', config.region, '--delete',
  '--exclude', '.build-report.json',
];
const invalidationArgs = [
  'cloudfront', 'create-invalidation',
  '--distribution-id', state.distributionId || '<DISTRIBUTION_ID>',
  '--paths', '/index.html',
];

function printPlan() {
  console.log('--- 日常发布计划（dry-run，不接触 AWS）---');
  console.log(`桶         : ${config.bucket} (${config.region})`);
  console.log(`分发 ID    : ${state.distributionId || '尚未初始化'}`);
  console.log(`正式地址   : ${config.siteUrl}`);
  console.log('');
  console.log('  aws --version');
  console.log(`  aws sts get-caller-identity --region ${config.region}`);
  console.log(`  aws s3 sync ${DIST} s3://${config.bucket}/ --region ${config.region} --delete --exclude .build-report.json`);
  console.log(`  aws cloudfront create-invalidation --distribution-id ${state.distributionId || '<ID>'} --paths /index.html`);
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
  console.log(`已同步 dist/，上传 ${uploads} 个对象。`);

  const invalidation = run(invalidationArgs);
  const detail = invalidation.json?.Invalidation || {};
  console.log(`缓存失效已提交：${detail.Id || '(无 Id)'} / ${detail.Status || 'unknown'}`);

  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  report.invalidation = {
    executed: true,
    paths: ['/index.html'],
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
