import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEPLOY_DIR = path.join(ROOT, 'src', 'deploy');
export const DIST = path.join(ROOT, 'dist');
export const STATE_FILE = path.join(ROOT, '.deploy-state.json');
export const DRY_RUN = process.argv.includes('--dry-run');

export async function loadConfig() {
  const config = JSON.parse(await readFile(path.join(DEPLOY_DIR, 'config.json'), 'utf8'));
  if (!config.siteUrl.startsWith('https://')) {
    throw new Error(`config.json 的 siteUrl 必须是 https://：${config.siteUrl}`);
  }
  if (config.acmRegion !== 'us-east-1') {
    throw new Error(`ACM 证书必须在 us-east-1（CloudFront 硬性要求），当前为 ${config.acmRegion}`);
  }
  return config;
}

export async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveState(state) {
  if (DRY_RUN) return;
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/** 所有 AWS 调用统一入口；失败即抛错，允许 allowFail 做幂等探测。 */
export function run(args, { allowFail = false } = {}) {
  const result = spawnSync('aws', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`无法执行 aws 命令：${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    throw new Error(`命令失败：aws ${args.join(' ')}\n${(result.stderr || '').trim()}`);
  }
  let json = null;
  if (result.status === 0 && result.stdout && result.stdout.trim()) {
    try { json = JSON.parse(result.stdout); } catch { /* 非 JSON 输出 */ }
  }
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    json,
  };
}

export function selfCheck(config) {
  const cli = run(['--version'], { allowFail: true });
  if (cli.status !== 0) {
    throw new Error('未找到 AWS CLI。请先运行：brew install awscli');
  }
  const identity = run(['sts', 'get-caller-identity', '--region', config.region], { allowFail: true });
  if (identity.status !== 0) {
    throw new Error('AWS 凭证不可用。请在自己的终端运行 aws configure / aws configure sso 后再试。');
  }
  const accountId = identity.json?.Account;
  if (!accountId) throw new Error('无法从 sts get-caller-identity 解析账号 ID');
  console.log(`AWS CLI ${cli.stdout.trim().split('\n')[0]}，账号 ${accountId}。`);
  return accountId;
}

/** OAC 桶策略 + IAM 最小权限。资源 ID 一律运行时注入，不硬编码。 */
export async function generatePolicies(config, state, accountId, { write = true } = {}) {
  const bucketArn = `arn:aws:s3:::${config.bucket}`;
  const distributionId = state.distributionId || 'DISTRIBUTION_ID';
  const account = accountId || '000000000000';
  const distributionArn = `arn:aws:cloudfront::${account}:distribution/${distributionId}`;

  const bucketPolicy = {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'AllowCloudFrontServicePrincipalReadOnly',
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject',
      Resource: `${bucketArn}/*`,
      Condition: { StringEquals: { 'AWS:SourceArn': distributionArn } },
    }],
  };

  const iamPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BucketConfig',
        Effect: 'Allow',
        Action: [
          's3:HeadBucket', 's3:GetBucketLocation',
          's3:PutBucketPolicy', 's3:GetBucketPolicy',
          's3:DeleteBucketWebsite',
          's3:PutBucketPublicAccessBlock', 's3:GetBucketPublicAccessBlock',
          's3:ListBucket',
        ],
        Resource: bucketArn,
      },
      {
        Sid: 'Objects',
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        Resource: `${bucketArn}/*`,
      },
      {
        Sid: 'AcmCertificate',
        Effect: 'Allow',
        Action: [
          'acm:RequestCertificate', 'acm:DescribeCertificate',
          'acm:ListCertificates', 'acm:ListTagsForCertificate',
        ],
        Resource: '*',
      },
      {
        Sid: 'CloudFrontSetup',
        Effect: 'Allow',
        Action: [
          'cloudfront:CreateDistribution', 'cloudfront:GetDistribution',
          'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution',
          'cloudfront:ListDistributions',
          'cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation',
          'cloudfront:CreateOriginAccessControl', 'cloudfront:GetOriginAccessControl',
          'cloudfront:ListOriginAccessControls', 'cloudfront:ListCachePolicies',
          'cloudfront:TagResource',
        ],
        Resource: '*',
      },
    ],
  };

  // 这两份是运行时生成的产物（含真实账号与分发 ID），已 gitignore；
  // 同时把对象本身返回出去，方便 verify 不依赖磁盘文件做断言。
  const bucketPolicyPath = path.join(DEPLOY_DIR, 'bucket-policy.json');
  const iamPolicyPath = path.join(DEPLOY_DIR, 'iam-policy.json');
  if (write) {
    await writeFile(bucketPolicyPath, `${JSON.stringify(bucketPolicy, null, 2)}\n`);
    await writeFile(iamPolicyPath, `${JSON.stringify(iamPolicy, null, 2)}\n`);
  }
  return { bucketPolicyPath, iamPolicyPath, bucketPolicy, iamPolicy };
}

export function printDnsRecords(config, state) {
  console.log('');
  console.log('请在域名 DNS 服务商处添加以下 CNAME 记录：');
  if (state.validationRecord) {
    console.log(`  1. ${state.validationRecord.Name}  ->  ${state.validationRecord.Value}`);
  } else {
    console.log('  1. _<hash>.<根域>.  ->  _<hash>.acm-validations.aws.');
    console.log('     （精确值由 ACM describe-certificate 返回，真实执行 Phase A 后输出）');
  }
  if (state.distributionDomainName) {
    console.log(`  2. ${config.domain}.  ->  ${state.distributionDomainName}.`);
  } else {
    console.log(`  2. ${config.domain}.  ->  <distribution>.cloudfront.net.`);
    console.log('     （精确值由 create-distribution 返回，真实执行 Phase C 后输出）');
  }
  console.log('');
}

export function findManagedCachePolicyId() {
  const result = run(['cloudfront', 'list-cache-policies', '--type', 'managed']);
  const items = result.json?.CachePolicyList?.Items || [];
  // AWS 实际返回的名字带 Managed- 前缀（Managed-CachingOptimized），兼容两种写法。
  const found = items.find((item) => {
    const name = item.CachePolicy?.CachePolicyConfig?.Name || '';
    return name === 'Managed-CachingOptimized' || name === 'CachingOptimized';
  });
  if (!found) throw new Error('未找到 Managed-CachingOptimized 托管缓存策略');
  return found.CachePolicy.Id;
}
