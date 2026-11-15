#!/usr/bin/env node
/**
 * 零依赖单测 / Unit tests with zero installs（V6，配套 docs/01-architecture.md 4.4a）。
 *
 * 把仓库拷一份到系统临时目录（**不带任何 node_modules**），在那里跑一遍全量单测，
 * 跑完删掉。它复现的是 `build-image.yml` 里那个 `test` job 的真实条件：一个包都不装。
 *
 * 为什么需要它：本机 `node_modules` 是「仓库根 + `src/server`」两套的并集，静态
 * `import` 又是无条件加载，于是**本机全绿证明不了 CI 会绿**。已经因此红过两次
 * main：`hero.mjs` 的 `@aws-sdk/client-s3`、`video.mjs` 的 `sharp`，两次都是整份
 * 测试文件在模块解析阶段就死掉，连一条断言都没跑到。`v6-artifact-publish` 里那条
 * 静态扫描用例挡的是「静态 import」这一类，这个脚本挡的是剩下所有「跑了才知道」的
 * 运行期依赖（比如某个函数里 `await import('sharp')` 了但没兜住）。
 *
 * 三条刻意的取舍：
 *   1. **不动本机 node_modules**：只读地拷走源码，不装、不卸、不改 lockfile；
 *   2. `dist/` 不拷（两个 job 都不需要），`node_modules` 无论在哪一层都跳过；
 *   3. 退出码就是 `node --test` 的退出码，所以能直接进 CI 或 git hook。
 *
 * Copies the repo to a temp dir without any node_modules and runs the full suite
 * there, reproducing the zero-install CI job. Exit code is the test runner's.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
/** 后面所有路径都相对这些顶层条目解析，加新目录记得加进来。 */
const ENTRIES = ['package.json', 'src', 'spec', 'scripts', 'docs', 'src/shared'];
/** 任何一层叫这个名字的都不拷——拷了就等于把本机的假象搬过去。 */
const SKIP = new Set(['node_modules', 'dist', '.git']);

const copyFilter = (source) => !SKIP.has(path.basename(source));

async function main() {
  const stamp = await mkdtemp(path.join(tmpdir(), 'album-bare-'));
  try {
    for (const entry of ENTRIES) {
      try {
        await cp(path.join(ROOT, entry), path.join(stamp, entry), {
          recursive: true,
          filter: copyFilter,
        });
      } catch (err) {
        // 可选的顶层条目（比如还没生成过的 dist）缺了就跳过，不算错。
        if (err.code !== 'ENOENT') throw err;
      }
    }

    console.log(`零依赖副本 / bare copy: ${stamp}`);
    console.log('（node_modules 与 dist 均已排除，等价于 CI 的单测 job）\n');

    const code = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['--test', 'src/server/test/*.test.mjs', 'src/web/test/*.test.mjs'],
        { cwd: stamp, stdio: 'inherit', shell: false },
      );
      // 注意事件参数的顺序是 (code, signal)，别写反。
      child.on('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
      child.on('error', () => resolve(1));
    });

    if (code !== 0) {
      console.error('\n零依赖环境下单测未通过：上面红的那条就是 CI 会红的，本机装没装包与它无关。');
      console.error('\nFailing under zero installs — these are exactly what CI would fail on.');
    }
    return code;
  } finally {
    // Windows 上 node --test 偶有文件句柄晚释放，删不掉不是错误，只是留了个临时目录。
    await rm(stamp, { recursive: true, force: true, maxRetries: 3 }).catch((err) => {
      console.warn(`临时目录清理失败（不影响结论）/ cleanup skipped: ${err.code || err.message}`);
    });
  }
}

process.exitCode = await main();
