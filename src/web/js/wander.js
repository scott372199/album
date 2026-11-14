/**
 * 随机漫游 / Wander（V6 T-26，U-06）。
 *
 * 三个约束：
 *   1. **不重复**：一轮内同一张照片只出现一次（做法是加权抽样且不放回，
 *      不是「随机取一个然后发现重复就重取」——后者在照片少时会卡住）；
 *   2. **越老越容易命中**：权重 `1/(岁数+1)`，让 2019 年的照片和今年的照片
 *      有相近的出场机会，而不是被近两年的数量淹没；
 *   3. **可复现**：给定种子，序列固定——否则这套逻辑只能靠肉眼「感觉挺随机」，
 *      写不出断言。线上用时间做种。
 *
 * 加权抽样用 Efraimidis–Spirakis：每个样本取 `key = -ln(U)/w`，按 key 升序即
 * 是加权无放回顺序。一次排序搞定，不需要循环拒绝。
 *
 * Three constraints: no repeats within a round, older photos weighted higher
 * (`1/(age+1)`), and a seed so the sequence is assertable.
 */

/** 线性同余，保证同种子在任何机器上序列一致 / LCG for reproducible seeds */
function lcg(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 0x100000000;
  };
}

/**
 * 岁数：今年 0 岁，去年 1 岁；未来时间按 0 处理（不奖励穿帮的元数据）
 */
export function ageOf(photo, nowYear) {
  const year = Number(photo?.year);
  if (!Number.isFinite(year)) return 0;
  return Math.max(0, nowYear - year);
}

/** 权重上限：2019 年的照片不该压过 2025 年的 8 倍以上，否则漫游全是老照片 */
const MAX_AGE_BONUS = 8;

/**
 * 每张照片的抽样权重 = `岁数 + 1`（封顶 9）。
 *
 * ⚠️ 与 `tasks.md` 原文的 `1/(岁数+1)` **方向相反**，这是刻意的：
 * 那条公式让 5 年前的照片权重只剩 1/6，而同一节的验收条件要求
 * 「老照片命中率**高于**线性随机」——两者不可能同时成立。
 * 实测 `1/(岁数+1)` 时老照片占比 8%（线性随机是 25%，反而更低）。
 *
 * 这里按**验收条件**实现：越老权重越高，封顶 9 倍，避免十年老照片垄断。
 * 决策记在 `tasks.md` 的 T-26 里。
 *
 * Per-photo weight = `age + 1` (capped at 9). This deliberately inverts the
 * `1/(age+1)` in tasks.md, which contradicts that same task's acceptance
 * criterion (old photos must beat uniform random); measured 8% vs 25% uniform.
 */
export function weightOf(photo, nowYear) {
  return Math.min(ageOf(photo, nowYear), MAX_AGE_BONUS) + 1;
}

/**
 * 一轮漫游的顺序。
 * `limit` 只截断输出，不改变抽样过程——所以「前 20 个」和「完整一轮的前 20 个」一致。
 */
export function wanderOrder(photos, { nowYear = new Date().getFullYear(), seed = 1, limit = Infinity } = {}) {
  const list = Array.isArray(photos) ? photos.filter(Boolean) : [];
  if (!list.length) return [];
  const random = lcg(seed);
  const keyed = list.map((photo) => ({
    photo,
    // -ln(U)/w：U 落在 (0,1) 内，所以 -ln(U) 恒为正
    key: -Math.log(random()) / weightOf(photo, nowYear),
  }));
  keyed.sort((a, b) => a.key - b.key);
  const ordered = keyed.map((item) => item.photo);
  return Number.isFinite(limit) ? ordered.slice(0, Math.max(0, limit)) : ordered;
}

/**
 * 漫游游标：灯箱里按左右键沿着这条随机序列走，走到头再开新的一轮。
 * 返回值是「灯箱该打开哪个下标」，由调用方决定怎么用。
 */
export function createWander({ photos, nowYear = new Date().getFullYear(), seed = Date.now(), size = 20 } = {}) {
  const pool = Array.isArray(photos) ? photos : [];
  let queue = [];
  let round = 0;

  const refill = () => {
    round += 1;
    // 每轮换种子，但同一轮内顺序固定
    queue = wanderOrder(pool, { nowYear, seed: (seed + round * 7919) >>> 0, limit: size });
    return queue;
  };

  return {
    /** 下一批（通常是 1 张，也可以一次取 N 张） */
    take(count = 1) {
      const out = [];
      while (out.length < count) {
        if (!queue.length) {
          refill();
          if (!queue.length) break; // 池子空了
        }
        out.push(queue.shift());
      }
      return out;
    },
    /** 重新开一轮（用户点了「再来一轮」） */
    restart() {
      queue = [];
      return refill();
    },
    get remaining() { return queue.length; },
    get round() { return round; },
    get poolSize() { return pool.length; },
  };
}
