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

/**
 * 每张照片的抽样权重 = `1/(岁数+1)`：今年 1.0，去年 0.5，五年前 ≈0.167。
 *
 * 按 `tasks.md` 原文实现（用户 2026-11-15 决定：**照原计划写、上线、用真实老照片验收**）。
 *
 * ⚠️ 已知矛盾，留给真实语料判定：同一节的验收条件写的是「老照片命中率**高于**
 * 线性随机」，而这条公式方向相反——在「今年 60 张 + 五年前 20 张」的合成夹具上，
 * 前 20 个里老照片只占 8%，线性随机是 25%。合成夹具说服不了任何人，
 * 所以这里不做「猜哪个才是本意」的改动，只把公式与其可观测后果都钉在测试里。
 *
 * Weight is `1/(age+1)` as written in tasks.md (user's call on 2026-11-15: ship the
 * formula, judge it against real old photos). The known conflict with the task's
 * own acceptance criterion is measured and recorded in the test, not "fixed" by
 * guessing which sentence was intended.
 */
export function weightOf(photo, nowYear) {
  return 1 / (ageOf(photo, nowYear) + 1);
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
