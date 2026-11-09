import {
  DEPLOY_DIR, DRY_RUN, generatePolicies, loadConfig, loadState,
  printDnsRecords, run, saveState, selfCheck,
} from './aws.mjs';
import { DISTRIBUTION_CONFIG_PATH, writeDistributionConfig } from './distribution-config.mjs';

const config = await loadConfig();
const state = await loadState();
/** 只创建分发、暂不收紧桶：等 DNS 记录 2 生效前保持 v1 站点可用。 */
const SKIP_LOCK = process.argv.includes('--skip-lock');

function printDryRun() {
  console.log('--- 首次引导计划（dry-run，不接触 AWS）---');
  console.log(`桶        : ${config.bucket} (${config.region})`);
  console.log(`ACM 区域  : ${config.acmRegion}`);
  console.log(`正式域名  : ${config.domain}`);
  console.log(`正式地址  : ${config.siteUrl}`);
  console.log('');
  const commands = [
    ['--version'],
    ['sts', 'get-caller-identity', '--region', config.region],
    ['acm', 'request-certificate', '--domain-name', config.domain,
      '--validation-method', 'DNS', '--region', config.acmRegion],
    ['acm', 'describe-certificate', '--certificate-arn', '<ARN>', '--region', config.acmRegion],
    ['acm', 'list-certificates', '--region', config.acmRegion],
    ['cloudfront', 'create-origin-access-control', '--origin-access-control-config', '<OAC_CONFIG>'],
    ['cloudfront', 'list-cache-policies', '--type', 'managed'],
    ['cloudfront', 'create-distribution', '--distribution-config',
      `file://${DISTRIBUTION_CONFIG_PATH}`],
    ['s3api', 'put-bucket-policy', '--bucket', config.bucket, '--region', config.region,
      '--policy', `file://${DEPLOY_DIR}/bucket-policy.json`],
    ['s3api', 'put-public-access-block', '--bucket', config.bucket, '--region', config.region,
      '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'],
    ['s3api', 'delete-bucket-website', '--bucket', config.bucket, '--region', config.region],
    ['cloudfront', 'get-distribution', '--id', '<ID>'],
  ];
  for (const args of commands) console.log(`  aws ${args.join(' ')}`);
  printDnsRecords(config, {});
  console.log('顺序：先建 CloudFront 分发，后收紧桶（避免回源 403）。');
  console.log('可选 --skip-lock：只创建分发、暂不收紧桶，等 DNS 记录 2 生效前保持 v1 可用。');
  console.log('Phase A 后需先添加记录 1，证书签发后重跑本命令继续；Phase C 后添加记录 2。');
  console.log('未执行任何 AWS 操作。去掉 --dry-run 即会真实执行。');
}

function findExistingCertificate() {
  const result = run(['acm', 'list-certificates', '--region', config.acmRegion], { allowFail: true });
  const list = result.json?.CertificateSummaryList || [];
  return list.find((item) => item.DomainName === config.domain)?.CertificateArn || null;
}

function findExistingOac() {
  const result = run(['cloudfront', 'list-origin-access-controls'], { allowFail: true });
  const list = result.json?.OriginAccessControlList?.Items || [];
  return list.find((item) => item.Name === config.oacName)?.Id || null;
}

function findExistingDistribution() {
  const result = run(['cloudfront', 'list-distributions'], { allowFail: true });
  const list = result.json?.DistributionList?.Items || [];
  const found = list.find((item) => item.Comment === config.distributionComment
    || (item.Aliases?.Items || []).includes(config.domain));
  return found ? { id: found.Id, domainName: found.DomainName } : null;
}

async function main() {
  await generatePolicies(config, state, null);

  if (DRY_RUN) {
    printDryRun();
    return;
  }

  const accountId = selfCheck(config);
  state.accountId = accountId;

  /* Phase A · 申请 / 复用 ACM 证书 */
  if (!state.certificateArn) {
    const existing = findExistingCertificate();
    if (existing) {
      state.certificateArn = existing;
      console.log('发现已存在的 ACM 证书，直接复用。');
    } else {
      const result = run([
        'acm', 'request-certificate',
        '--domain-name', config.domain,
        '--validation-method', 'DNS',
        '--region', config.acmRegion,
      ]);
      state.certificateArn = result.json?.CertificateArn;
      if (!state.certificateArn) throw new Error('ACM 证书申请未返回 CertificateArn');
      console.log(`已申请 ACM 证书：${state.certificateArn}`);
    }
    state.phase = 'A';
    await saveState(state);
  }

  /* Phase B · 读取验证记录并检查签发状态 */
  const certificate = run([
    'acm', 'describe-certificate',
    '--certificate-arn', state.certificateArn,
    '--region', config.acmRegion,
  ]).json?.Certificate;
  if (!certificate) throw new Error('无法读取 ACM 证书详情');
  const record = certificate.DomainValidationOptions?.[0]?.ResourceRecord;
  if (record) state.validationRecord = { Name: record.Name, Value: record.Value };
  state.certificateStatus = certificate.Status;
  await saveState(state);

  if (certificate.Status !== 'ISSUED') {
    console.log(`证书状态：${certificate.Status}（尚未签发）`);
    console.log('请先在 DNS 添加记录 1，生效后重跑 npm run deploy:init 继续。');
    printDnsRecords(config, state);
    state.phase = 'B';
    await saveState(state);
    return;
  }

  /* Phase C · OAC + CloudFront 分发 */
  if (!state.oacId) {
    const existing = findExistingOac();
    if (existing) {
      state.oacId = existing;
      console.log('发现已存在的 OAC，直接复用。');
    } else {
      const result = run([
        'cloudfront', 'create-origin-access-control',
        '--origin-access-control-config',
        `Name=${config.oacName},Description=OAC-for-${config.domain},` +
        'OriginAccessControlOriginType=s3,SigningBehavior=always,SigningProtocol=sigv4',
      ]);
      state.oacId = result.json?.OriginAccessControl?.Id;
      if (!state.oacId) throw new Error('OAC 创建未返回 Id');
      console.log(`已创建 OAC：${state.oacId}`);
    }
    await saveState(state);
  }

  if (!state.distributionId) {
    const existing = findExistingDistribution();
    if (existing) {
      state.distributionId = existing.id;
      state.distributionDomainName = existing.domainName;
      console.log('发现已存在的 CloudFront 分发，直接复用。');
    } else {
      const configPath = await writeDistributionConfig(config, state);
      const result = run([
        'cloudfront', 'create-distribution',
        '--distribution-config', `file://${configPath}`,
      ]);
      state.distributionId = result.json?.Distribution?.Id;
      state.distributionDomainName = result.json?.Distribution?.DomainName;
      if (!state.distributionId) throw new Error('分发创建未返回 Id');
      console.log(`已创建 CloudFront 分发：${state.distributionId}`);
    }
    state.phase = 'C';
    await saveState(state);
  }

  console.log('请在 DNS 添加记录 2（如尚未添加）：');
  printDnsRecords(config, state);

  /* Phase D · 先分发、后收紧桶 */
  if (SKIP_LOCK) {
    console.log('--skip-lock：本轮不收紧桶，v1 的 HTTP 网站端点继续可用。');
  } else if (!state.bucketLocked) {
    const { bucketPolicyPath } = await generatePolicies(config, state, accountId);
    run([
      's3api', 'put-bucket-policy',
      '--bucket', config.bucket, '--region', config.region,
      '--policy', `file://${bucketPolicyPath}`,
    ]);
    run([
      's3api', 'put-public-access-block',
      '--bucket', config.bucket, '--region', config.region,
      '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
    ]);
    const website = run([
      's3api', 'delete-bucket-website',
      '--bucket', config.bucket, '--region', config.region,
    ], { allowFail: true });
    console.log(website.status === 0 ? '已关闭 S3 静态网站托管。' : '静态网站托管本就未启用，跳过。');
    state.bucketLocked = true;
    state.phase = 'D';
    await saveState(state);
    console.log('桶已改为私有，v1 的 HTTP 网站端点已下线。');
  }

  /* Phase E / F · 分发部署状态 */
  const distribution = run([
    'cloudfront', 'get-distribution', '--id', state.distributionId,
  ]).json?.Distribution;
  const status = distribution?.Status || 'Unknown';
  state.distributionStatus = status;
  await saveState(state);

  if (status !== 'Deployed') {
    console.log(`CloudFront 分发状态：${status}（部署中，稍后重跑本命令即可，不会阻塞等待）`);
    if (SKIP_LOCK) console.log('本轮未收紧桶，v1 HTTP 站点继续可用；请同时添加 DNS 记录 2。');
    state.phase = 'E';
    await saveState(state);
    return;
  }

  if (SKIP_LOCK && !state.bucketLocked) {
    state.phase = 'C';
    await saveState(state);
    console.log('');
    console.log('--- 分发已就绪，等待 DNS 记录 2 ---');
    console.log(`CloudFront 默认域名：${state.distributionDomainName}`);
    console.log(`正式地址：${config.siteUrl}`);
    console.log('请在 DNS 添加记录 2 并等生效，然后重跑 npm run deploy:init（不带 --skip-lock）完成桶私有化，再执行 npm run deploy。');
    return;
  }

  state.phase = 'F';
  await saveState(state);
  console.log('');
  console.log('--- 首次引导完成 ---');
  console.log(`CloudFront 默认域名：${state.distributionDomainName}（可用于 DNS 生效前验证 HTTPS 回源）`);
  console.log(`正式地址：${config.siteUrl}`);
  console.log('下一步：DNS 记录 2 生效后，执行 npm run deploy 上传产物。');
}

main().catch((err) => {
  console.error(`首次引导失败：${err.message}`);
  process.exitCode = 1;
});
