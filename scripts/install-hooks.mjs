#!/usr/bin/env node
/**
 * 安装本地 pre-commit 钩子（只影响本机，不随仓库分发）。
 * 重复执行是安全的：已有同名钩子会先备份为 pre-commit.bak。
 */
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, '.git', 'hooks', 'pre-commit');
const CONTENT = `#!/bin/sh
# 由 scripts/install-hooks.mjs 生成：提交前跑一次仓库安检
node scripts/check-repo.mjs || {
  echo ""
  echo "提交已中止。确认无误可用 git commit --no-verify 跳过（不建议）。"
  exit 1
}
`;

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const hooksDir = path.dirname(HOOK);
if (!(await exists(path.join(ROOT, '.git')))) {
  console.error('当前目录不是 git 仓库，先执行 git init。');
  process.exit(1);
}

await mkdir(hooksDir, { recursive: true });

if (await exists(HOOK)) {
  const current = await readFile(HOOK, 'utf8');
  if (current === CONTENT) {
    console.log('pre-commit 钩子已是最新，无需更改。');
    process.exit(0);
  }
  await writeFile(`${HOOK}.bak`, current, 'utf8');
  console.log(`已备份原钩子到 ${path.relative(ROOT, HOOK)}.bak`);
}

await writeFile(HOOK, CONTENT, 'utf8');
await chmod(HOOK, 0o755);
console.log('已安装 pre-commit 钩子：每次提交前自动运行 npm run check:repo。');
