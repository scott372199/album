#!/usr/bin/env node
/**
 * 仓库安检：把「不该进仓库的东西」拦在提交与推送之前。
 *
 * 检查对象：git 已跟踪文件 + 未跟踪但未被忽略的文件。
 * 命中任一条即以非零码退出，并逐条打印原因。
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.avif',
  '.gif', '.mp4', '.mov', '.m4v', '.tiff', '.tif', '.bmp',
]);

const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.cjs', '.json', '.css', '.html', '.htm',
  '.csv', '.txt', '.yml', '.yaml', '.toml', '.sh', '.env', '.example',
]);

const MAX_BYTES = 5 * 1024 * 1024;

const SECRET_PATTERNS = [
  { name: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: '私钥文件内容', re: /BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY/ },
  // 拆开拼接：本文件自身不应包含可被匹配的完整字面量
  { name: 'AWS secret', re: new RegExp(['aws', 'secret', 'access', 'key'].join('_'), 'i') },
  { name: 'GitHub token', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'OpenAI 风格 token', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
];

const ABSOLUTE_PATH = /\/Users\/[A-Za-z0-9._-]+\//;

/** 文档里会「描述」密钥长相，属正常内容；只对代码与配置做密钥扫描。 */
const DOC_PATH = /^(spec\/)|^README\.md$/;

async function gitFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(Boolean);
}

function isTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  // 无扩展名的常见文本文件（.gitignore / .albumignore 等）
  return path.basename(file).startsWith('.') || ext === '';
}

const problems = [];

function report(file, reason) {
  problems.push({ file, reason });
}

const files = await gitFiles();

if (!files.length) {
  console.log('仓库安检：没有可检查的文件（还没 git add？）');
  process.exit(0);
}

for (const file of files) {
  const abs = path.join(ROOT, file);
  const ext = path.extname(file).toLowerCase();

  if (file.startsWith('dist/')) {
    report(file, '构建产物不应入库');
    continue;
  }

  if (MEDIA_EXT.has(ext)) {
    report(file, `媒体文件（${ext}）不应入库`);
    continue;
  }

  let info;
  try {
    info = await stat(abs);
  } catch {
    continue; // 已被删除的暂存文件
  }
  if (!info.isFile()) continue;

  if (info.size > MAX_BYTES) {
    report(file, `超过 5MB（${(info.size / 1024 / 1024).toFixed(1)}MB）`);
    continue;
  }

  if (!isTextFile(file) || info.size > 512 * 1024) continue;

  let text;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    continue;
  }

  for (const { name, re } of SECRET_PATTERNS) {
    if (!DOC_PATH.test(file) && re.test(text)) report(file, `疑似${name}`);
  }

  if (ABSOLUTE_PATH.test(text)) {
    report(file, '含本机绝对路径（/Users/<name>/）');
  }
}

if (problems.length) {
  console.error('仓库安检未通过：');
  for (const { file, reason } of problems) {
    console.error(`  ✗ ${file}: ${reason}`);
  }
  console.error(`\n共 ${problems.length} 项。请移出仓库或加入 .gitignore 后重试。`);
  process.exit(1);
}

console.log(`仓库安检通过：检查了 ${files.length} 个文件，无媒体、密钥、大文件或绝对路径。`);
