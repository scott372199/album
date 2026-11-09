import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DIST, DRY_RUN, ROOT, loadConfig, run, selfCheck } from './aws.mjs';

/**
 * 临时预览部署：CloudFront 账号验证期间，把 v2 产物发到现有公开 S3 桶，
 * 用 v1 的 website endpoint 在线查看真实效果。
 *
 * 刻意不做：CloudFront 缓存失效、桶策略变更、关闭 website hosting、
 * --delete（保留 v1 旧对象）、绑定域名。
 *
 * 三种模式：
 *   node preview.mjs               上传 v2 预览
 *   node preview.mjs --dry-run     只打印计划，不接触 AWS
 *   node preview.mjs --rollback    从备份恢复 v1 入口页
 */
const ROLLBACK = process.argv.includes('--rollback');
const config = await loadConfig();
const previewUrl = `http://${config.bucket}.s3-website-${config.region}.amazonaws.com`;
const backupDir = path.join(ROOT, '.rollback-v1');
const backupFile = path.join(backupDir, 'index.html');
const s3Index = `s3://${config.bucket}/${config.indexDocument}`;
const syncArgs = [
  's3', 'sync', `${DIST}/`, `s3://${config.bucket}/`,
  '--region', config.region,
  '--exclude', '.build-report.json',
];

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function rollbackHint() {
  return `aws s3 cp "${backupFile}" ${s3Index} --region ${config.region}`;
}

async function main() {
  if (DRY_RUN) {
    console.log('--- 临时预览部署计划（dry-run，不接触 AWS）---');
    console.log(`目标桶   : ${config.bucket} (${config.region})`);
    console.log(`临时地址 : ${previewUrl}`);
    console.log(`备份位置 : ${path.relative(ROOT, backupFile)}（已存在则不覆盖）`);
    console.log('');
    console.log(`  aws s3 cp ${s3Index} ${backupFile} --region ${config.region}`);
    console.log(`  aws ${[...syncArgs, '--dryrun'].join(' ')}`);
    console.log(`  aws ${syncArgs.join(' ')}`);
    console.log('');
    console.log('不带 --delete：保留 v1 旧对象便于回滚。');
    console.log('不做缓存失效、不改桶策略、不动 CloudFront、不绑定域名。');
    console.log('未执行任何 AWS 操作。去掉 --dry-run 即会真实上传。');
    return;
  }

  selfCheck(config);

  if (ROLLBACK) {
    if (!(await exists(backupFile))) {
      throw new Error(`找不到备份文件 ${backupFile}，无法回滚（可能尚未运行过预览部署）`);
    }
    run(['s3', 'cp', backupFile, s3Index, '--region', config.region]);
    console.log('');
    console.log('--- 已回滚 v1 入口页 ---');
    console.log(`地址：${previewUrl}`);
    console.log('v2 的资源对象仍留在桶中（无 --delete），但不被入口页引用，不影响显示。');
    return;
  }

  await mkdir(backupDir, { recursive: true });
  if (await exists(backupFile)) {
    console.log(`已存在 v1 入口页备份，跳过重复备份以保留最初版本：${path.relative(ROOT, backupFile)}`);
  } else {
    const backup = run(
      ['s3', 'cp', s3Index, backupFile, '--region', config.region],
      { allowFail: true },
    );
    if (backup.status !== 0) {
      throw new Error(`备份 v1 入口页失败，已中止，未上传任何内容。\n${backup.stderr.trim()}`);
    }
    console.log(`已备份 v1 入口页 → ${path.relative(ROOT, backupFile)}`);
  }

  const preview = run([...syncArgs, '--dryrun'], { allowFail: true });
  const uploads = (preview.stdout.match(/upload:/g) || []).length;
  console.log(`同步预览：将上传约 ${uploads} 个对象（不删除旧对象）。`);

  run(syncArgs);

  console.log('');
  console.log('--- 临时预览部署完成（仅 S3）---');
  console.log(`临时地址：${previewUrl}`);
  console.log('未做：CloudFront 缓存失效 / 桶策略变更 / 关闭 website hosting / 绑定域名。');
  console.log(`一键回滚：npm run deploy:preview:rollback`);
  console.log(`等价命令：${rollbackHint()}`);
  console.log('CloudFront 账号验证通过后按正式流程继续：npm run deploy:init -- --skip-lock → npm run deploy。');
}

main().catch((err) => {
  console.error(`临时预览部署失败：${err.message}`);
  process.exitCode = 1;
});
