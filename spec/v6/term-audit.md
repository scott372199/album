# V6 词表覆盖率审计 / Term coverage audit

> 由 `scripts/audit-terms.mjs` 生成。**只含识别词与计数，不含任何照片 id、路径或相册名。**

- 索引文件 / index：`data/search-index.json`
- 索引版本 / version：`v5.1.0`
- 照片总数 / items：47
- 有标签的照片：34（100.0%）
- distinct term：118
- 已发布索引：有真中文名 12；缺 106（其中占位=英文 106，空值 0）
- **用当前词表重建后仍缺：0**（已覆盖 540 条标签出现）

> ⚠️ 「占位=英文」指 `zh` 被 `zhForTerm()` 兜底填成了 term 本身，**该标签只能用英文检索**，对中文用户等于不可搜。

> 索引里的 `zh` 是**上一次建索引时**解析的，会滞后于词表。判 T-04 进度看下面第二节。

## 重建索引后仍缺中文名 / Still missing after a rebuild

无。当前词表已覆盖全部已识别 term，重建索引即可生效。

## 已发布索引的缺口（历史对照）/ Gaps in the published index

| term | 出现张数 | 覆盖率 | 状态 | kind | 最高置信度 |
| --- | --- | --- | --- | --- | --- |
| `grey` | 34 | 100.0% | 占位=英文 | color | 0.5 |
| `person` | 33 | 97.1% | 占位=英文 | object | 1.0 |
| `brown` | 28 | 82.4% | 占位=英文 | color | 0.3 |
| `head` | 25 | 73.5% | 占位=英文 | object | 1.0 |
| `boy` | 24 | 70.6% | 占位=英文 | object | 1.0 |
| `child` | 24 | 70.6% | 占位=英文 | object | 1.0 |
| `face` | 24 | 70.6% | 占位=英文 | object | 1.0 |
| `male` | 24 | 70.6% | 占位=英文 | object | 1.0 |
| `people` | 9 | 26.5% | 占位=英文 | object | 1.0 |
| `sleeve` | 9 | 26.5% | 占位=英文 | object | 1.0 |
| `happy` | 7 | 20.6% | 占位=英文 | object | 1.0 |
| `pink` | 7 | 20.6% | 占位=英文 | color | 0.1 |
| `sitting` | 7 | 20.6% | 占位=英文 | object | 1.0 |
| `adult` | 5 | 14.7% | 占位=英文 | object | 1.0 |
| `food` | 5 | 14.7% | 占位=英文 | object | 1.0 |
| `furniture` | 5 | 14.7% | 占位=英文 | object | 1.0 |
| `indoors` | 4 | 11.8% | 占位=英文 | object | 0.9 |
| `man` | 4 | 11.8% | 占位=英文 | object | 1.0 |
| `shorts` | 4 | 11.8% | 占位=英文 | object | 0.9 |
| `urban` | 4 | 11.8% | 占位=英文 | color | 1.0 |
| `accessories` | 3 | 8.8% | 占位=英文 | object | 0.9 |
| `bag` | 3 | 8.8% | 占位=英文 | object | 0.9 |
| `black hair` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `city` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `cream` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `dessert` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `electronics` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `female` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `footwear` | 3 | 8.8% | 占位=英文 | object | 0.9 |
| `hair` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `handbag` | 3 | 8.8% | 占位=英文 | object | 0.9 |
| `ice cream` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `orange` | 3 | 8.8% | 占位=英文 | color | 0.1 |
| `pants` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `photography` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `portrait` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `shoe` | 3 | 8.8% | 占位=英文 | object | 0.9 |
| `sliding` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `smile` | 3 | 8.8% | 占位=英文 | object | 1.0 |
| `architecture` | 2 | 5.9% | 占位=英文 | object | 1.0 |
| `art` | 2 | 5.9% | 占位=英文 | object | 1.0 |
| `baby` | 2 | 5.9% | 占位=英文 | object | 1.0 |
| `christmas` | 2 | 5.9% | 占位=英文 | object | 0.9 |
| `christmas decorations` | 2 | 5.9% | 占位=英文 | object | 0.9 |
| `computer` | 2 | 5.9% | 占位=英文 | object | 1.0 |
| `cup` | 2 | 5.9% | 占位=英文 | object | 0.9 |
| `festival` | 2 | 5.9% | 占位=英文 | object | 0.9 |
| `girl` | 2 | 5.9% | 占位=英文 | object | 1.0 |
| `pajamas` | 2 | 5.9% | 占位=英文 | object | 0.9 |
| `plant` | 2 | 5.9% | 占位=英文 | object | 1.0 |
| `road` | 2 | 5.9% | 占位=英文 | object | 0.9 |
| `street` | 2 | 5.9% | 占位=英文 | object | 0.9 |
| `table` | 2 | 5.9% | 占位=英文 | object | 1.0 |
| `text` | 2 | 5.9% | 占位=英文 | object | 0.9 |
| `advertisement` | 1 | 2.9% | 占位=英文 | object | 0.9 |
| `baby laughing` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `baseball cap` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `bowl` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `box` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `building` | 1 | 2.9% | 占位=英文 | object | 0.9 |
| `bus` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `cap` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `chair` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `christmas tree` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `computer hardware` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `conversation` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `cutlery` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `desk` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `disposable cup` | 1 | 2.9% | 占位=英文 | object | 0.9 |
| `family` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `fountain` | 1 | 2.9% | 占位=英文 | scene | 1.0 |
| `foyer` | 1 | 2.9% | 占位=英文 | object | 0.9 |
| `grass` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `handicraft` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `hardware` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `hat` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `icing` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `laptop` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `leaf` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `lego set` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `machine` | 1 | 2.9% | 占位=英文 | object | 0.9 |
| `monitor` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `number` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `paint container` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `painting` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `park` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `pc` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `performer` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `purple` | 1 | 2.9% | 占位=英文 | color | 0.0 |
| `romantic` | 1 | 2.9% | 占位=英文 | object | 0.9 |
| `screen` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `soft serve ice cream` | 1 | 2.9% | 占位=英文 | object | 0.9 |
| `solo performance` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `spoon` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `standing` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `student` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `symbol` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `tablet computer` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `toy` | 1 | 2.9% | 占位=英文 | object | 0.7 |
| `triumphant` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `walking` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `waterfront` | 1 | 2.9% | 占位=英文 | scene | 0.8 |
| `wedding proposal` | 1 | 2.9% | 占位=英文 | object | 0.8 |
| `wheel` | 1 | 2.9% | 占位=英文 | object | 0.9 |
| `woman` | 1 | 2.9% | 占位=英文 | object | 1.0 |
| `working out` | 1 | 2.9% | 占位=英文 | object | 0.7 |

## 全部 term / All terms

| term | 出现张数 | 覆盖率 | 中文名（重建后） | kind |
| --- | --- | --- | --- | --- |
| `grey` | 34 | 100.0% | 灰色 | color |
| `person` | 33 | 97.1% | 人物 | object |
| `brown` | 28 | 82.4% | 棕色 | color |
| `black` | 25 | 73.5% | 黑色 | color |
| `head` | 25 | 73.5% | 头 | object |
| `boy` | 24 | 70.6% | 男孩 | object |
| `child` | 24 | 70.6% | 小孩 | object |
| `face` | 24 | 70.6% | 脸 | object |
| `male` | 24 | 70.6% | 男性 | object |
| `blue` | 22 | 64.7% | 蓝色 | color |
| `shirt` | 18 | 52.9% | 衬衫 | object |
| `green` | 13 | 38.2% | 绿色 | color |
| `red` | 12 | 35.3% | 红色 | color |
| `yellow` | 12 | 35.3% | 黄色 | color |
| `people` | 9 | 26.5% | 人群 | object |
| `sleeve` | 9 | 26.5% | 袖子 | object |
| `happy` | 7 | 20.6% | 开心 | object |
| `pink` | 7 | 20.6% | 粉色 | color |
| `sitting` | 7 | 20.6% | 坐着 | object |
| `adult` | 5 | 14.7% | 大人 | object |
| `food` | 5 | 14.7% | 食物 | object |
| `furniture` | 5 | 14.7% | 家具 | object |
| `indoors` | 4 | 11.8% | 室内 | object |
| `man` | 4 | 11.8% | 男人 | object |
| `shorts` | 4 | 11.8% | 短裤 | object |
| `urban` | 4 | 11.8% | 都市 | color |
| `accessories` | 3 | 8.8% | 配饰 | object |
| `bag` | 3 | 8.8% | 包 | object |
| `black hair` | 3 | 8.8% | 黑发 | object |
| `car` | 3 | 8.8% | 汽车 | object |
| `city` | 3 | 8.8% | 城市 | object |
| `cream` | 3 | 8.8% | 奶油 | object |
| `dessert` | 3 | 8.8% | 甜点 | object |
| `electronics` | 3 | 8.8% | 电子产品 | object |
| `female` | 3 | 8.8% | 女性 | object |
| `footwear` | 3 | 8.8% | 鞋类 | object |
| `hair` | 3 | 8.8% | 头发 | object |
| `handbag` | 3 | 8.8% | 手提包 | object |
| `ice cream` | 3 | 8.8% | 冰淇淋 | object |
| `orange` | 3 | 8.8% | 橙色 | color |
| `pants` | 3 | 8.8% | 裤子 | object |
| `photography` | 3 | 8.8% | 摄影 | object |
| `portrait` | 3 | 8.8% | 人像 | object |
| `shoe` | 3 | 8.8% | 鞋 | object |
| `sliding` | 3 | 8.8% | 滑梯 | object |
| `smile` | 3 | 8.8% | 微笑 | object |
| `transportation` | 3 | 8.8% | 交通工具 | object |
| `white` | 3 | 8.8% | 白色 | color |
| `architecture` | 2 | 5.9% | 建筑 | object |
| `art` | 2 | 5.9% | 艺术 | object |
| `baby` | 2 | 5.9% | 宝宝 | object |
| `christmas` | 2 | 5.9% | 圣诞 | object |
| `christmas decorations` | 2 | 5.9% | 圣诞装饰 | object |
| `computer` | 2 | 5.9% | 电脑 | object |
| `cup` | 2 | 5.9% | 杯子 | object |
| `festival` | 2 | 5.9% | 节日 | object |
| `girl` | 2 | 5.9% | 女孩 | object |
| `lake` | 2 | 5.9% | 湖水 | scene |
| `pajamas` | 2 | 5.9% | 睡衣 | object |
| `plant` | 2 | 5.9% | 植物 | object |
| `road` | 2 | 5.9% | 马路 | object |
| `street` | 2 | 5.9% | 街道 | object |
| `table` | 2 | 5.9% | 桌子 | object |
| `text` | 2 | 5.9% | 文字 | object |
| `advertisement` | 1 | 2.9% | 广告 | object |
| `baby laughing` | 1 | 2.9% | 宝宝笑 | object |
| `baseball cap` | 1 | 2.9% | 棒球帽 | object |
| `bowl` | 1 | 2.9% | 碗 | object |
| `box` | 1 | 2.9% | 盒子 | object |
| `building` | 1 | 2.9% | 楼房 | object |
| `bus` | 1 | 2.9% | 公交车 | object |
| `cap` | 1 | 2.9% | 帽子 | object |
| `chair` | 1 | 2.9% | 椅子 | object |
| `christmas tree` | 1 | 2.9% | 圣诞树 | object |
| `computer hardware` | 1 | 2.9% | 电脑硬件 | object |
| `conversation` | 1 | 2.9% | 交谈 | object |
| `cutlery` | 1 | 2.9% | 餐具 | object |
| `desk` | 1 | 2.9% | 书桌 | object |
| `disposable cup` | 1 | 2.9% | 一次性杯 | object |
| `family` | 1 | 2.9% | 全家福 | object |
| `fountain` | 1 | 2.9% | 喷泉 | scene |
| `foyer` | 1 | 2.9% | 门厅 | object |
| `grass` | 1 | 2.9% | 草地 | object |
| `handicraft` | 1 | 2.9% | 手工 | object |
| `hardware` | 1 | 2.9% | 硬件 | object |
| `hat` | 1 | 2.9% | 礼帽 | object |
| `icing` | 1 | 2.9% | 糖霜 | object |
| `laptop` | 1 | 2.9% | 笔记本电脑 | object |
| `leaf` | 1 | 2.9% | 树叶 | object |
| `lego set` | 1 | 2.9% | 乐高 | object |
| `machine` | 1 | 2.9% | 机器 | object |
| `monitor` | 1 | 2.9% | 显示器 | object |
| `nature` | 1 | 2.9% | 自然 | scene |
| `number` | 1 | 2.9% | 数字 | object |
| `outdoors` | 1 | 2.9% | 户外 | scene |
| `paint container` | 1 | 2.9% | 颜料罐 | object |
| `painting` | 1 | 2.9% | 画作 | object |
| `park` | 1 | 2.9% | 公园 | object |
| `pc` | 1 | 2.9% | 台式电脑 | object |
| `performer` | 1 | 2.9% | 表演者 | object |
| `purple` | 1 | 2.9% | 紫色 | color |
| `romantic` | 1 | 2.9% | 浪漫 | object |
| `screen` | 1 | 2.9% | 屏幕 | object |
| `soft serve ice cream` | 1 | 2.9% | 甜筒 | object |
| `solo performance` | 1 | 2.9% | 独奏 | object |
| `spoon` | 1 | 2.9% | 勺子 | object |
| `standing` | 1 | 2.9% | 站着 | object |
| `student` | 1 | 2.9% | 学生 | object |
| `symbol` | 1 | 2.9% | 符号 | object |
| `tablet computer` | 1 | 2.9% | 平板电脑 | object |
| `toy` | 1 | 2.9% | 玩具 | object |
| `triumphant` | 1 | 2.9% | 欢呼 | object |
| `walking` | 1 | 2.9% | 走路 | object |
| `waterfront` | 1 | 2.9% | 水边 | scene |
| `wedding proposal` | 1 | 2.9% | 求婚 | object |
| `wheel` | 1 | 2.9% | 车轮 | object |
| `woman` | 1 | 2.9% | 女人 | object |
| `working out` | 1 | 2.9% | 健身 | object |
