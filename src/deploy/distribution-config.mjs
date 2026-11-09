import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEPLOY_DIR, findManagedCachePolicyId } from './aws.mjs';

export const DISTRIBUTION_CONFIG_PATH = path.join(DEPLOY_DIR, 'distribution-config.json');

/**
 * 生成 CloudFront DistributionConfig。
 * 关键点：普通 S3 REST 源站 + OAC、DefaultRootObject 兜底根路径、
 * redirect-to-https、ACM 证书、且不配置 CustomErrorResponses（见 plan §5.6）。
 */
export function buildDistributionConfig(config, state, cachePolicyId) {
  if (!state.oacId) throw new Error('缺少 oacId，请先创建 Origin Access Control');
  if (!state.certificateArn) throw new Error('缺少 certificateArn，请先申请并签发 ACM 证书');

  const originId = `s3-${config.bucket}`;
  return {
    CallerReference: `album-v2-${config.bucket}`,
    Comment: config.distributionComment,
    Enabled: true,
    HttpVersion: 'http2and3',
    PriceClass: 'PriceClass_200',
    DefaultRootObject: config.indexDocument,
    Aliases: { Quantity: 1, Items: [config.domain] },
    Origins: {
      Quantity: 1,
      Items: [{
        Id: originId,
        DomainName: `${config.bucket}.s3.${config.region}.amazonaws.com`,
        OriginPath: '',
        CustomHeaders: { Quantity: 0 },
        // OAC 场景下 OriginAccessIdentity 必须显式传空串（CLI 参数校验要求）。
        S3OriginConfig: { OriginAccessIdentity: '' },
        OriginAccessControlId: state.oacId,
        ConnectionAttempts: 3,
        ConnectionTimeout: 10,
      }],
    },
    OriginGroups: { Quantity: 0 },
    DefaultCacheBehavior: {
      TargetOriginId: originId,
      ViewerProtocolPolicy: 'redirect-to-https',
      TrustedSigners: { Enabled: false, Quantity: 0 },
      TrustedKeyGroups: { Enabled: false, Quantity: 0 },
      AllowedMethods: {
        Quantity: 2,
        Items: ['GET', 'HEAD'],
        CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
      },
      Compress: true,
      CachePolicyId: cachePolicyId,
      SmoothStreaming: false,
      FieldLevelEncryptionId: '',
    },
    CacheBehaviors: { Quantity: 0 },
    CustomErrorResponses: { Quantity: 0 },
    ViewerCertificate: {
      ACMCertificateArn: state.certificateArn,
      SSLSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1.2_2021',
      Certificate: state.certificateArn,
      CertificateSource: 'acm',
    },
    Restrictions: {
      GeoRestriction: { RestrictionType: 'none', Quantity: 0 },
    },
    WebACLId: '',
  };
}

/** managed cache policy ID 运行时查询，不硬编码。 */
export async function writeDistributionConfig(config, state) {
  const cachePolicyId = findManagedCachePolicyId();
  const distributionConfig = buildDistributionConfig(config, state, cachePolicyId);
  await writeFile(DISTRIBUTION_CONFIG_PATH, `${JSON.stringify(distributionConfig, null, 2)}\n`);
  return DISTRIBUTION_CONFIG_PATH;
}
