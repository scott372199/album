#!/usr/bin/env node
/**
 * 生成认证用的密钥材料。三个值各有各的来历，混在一起最容易搞错：
 *
 *   TF_VAR_shared_key_hash  ← 本脚本对「共享密钥原文」算出 scrypt 哈希
 *   TF_VAR_jwt_secret       ← 本脚本随机生成（--jwt）
 *   TF_VAR_auth_phones      ← 手动填手机号，逗号分隔
 *
 * 明文共享密钥**只**发给使用方，不进仓库、不进 state、不进 CI 变量。
 * The plaintext shared key goes to users only — never the repo, the state file
 * or CI variables.
 */

import { randomBytes } from 'node:crypto';
import { hashSharedKey } from '../src/server/lib/scrypt.mjs';

const args = process.argv.slice(2);

function generateSharedKey() {
  // 32 字节 base64url ≈ 43 个字符，手输不便但可以复制；去掉容易看错的 - 和 _
  // 不合适：base64url 的字母表本身就含这两个，索性保留并使用系统粘贴。
  return randomBytes(32).toString('base64url');
}

if (args.includes('--jwt')) {
  // JWT 密钥只做 HMAC，不需要可读性，越长越好
  console.log(randomBytes(48).toString('base64url'));
  process.exit(0);
}

const plain = args.find((arg) => !arg.startsWith('--'));

if (!plain) {
  const generated = generateSharedKey();
  console.log('# 已生成新的共享密钥与其哈希 / generated a shared key and its hash');
  console.log('');
  console.log(`共享密钥（发给使用方，只此一份）: ${generated}`);
  console.log('');
  console.log('TF_VAR_shared_key_hash=');
  console.log(hashSharedKey(generated));
  process.exit(0);
}

console.log(hashSharedKey(plain));
