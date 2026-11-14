# V6 词表覆盖率审计 / Term coverage audit

> 由 `scripts/audit-terms.mjs` 生成。**只含识别词与计数，不含任何照片 id、路径或相册名。**

- 索引文件 / index：`data/search-index.json`
- 索引版本 / version：`v5.1.0`
- 照片总数 / items：47
- 有标签的照片：34（100.0%）
- distinct term：118
- **有真中文名：12；缺中文名：106**（其中占位=英文 106，空值 0）

> ⚠️ 「占位=英文」指 `zh` 被 `zhForTerm()` 兜底填成了 term 本身，**该标签只能用英文检索**，对中文用户等于不可搜。

## 缺中文名的 term（按出现张数排序）/ Terms without a real Chinese name

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

| term | 出现张数 | 覆盖率 | 中文名 | kind |
| --- | --- | --- | --- | --- |
| `grey` | 34 | 100.0% | **缺** | color |
| `person` | 33 | 97.1% | **缺** | object |
| `brown` | 28 | 82.4% | **缺** | color |
| `black` | 25 | 73.5% | 黑色 | color |
| `head` | 25 | 73.5% | **缺** | object |
| `boy` | 24 | 70.6% | **缺** | object |
| `child` | 24 | 70.6% | **缺** | object |
| `face` | 24 | 70.6% | **缺** | object |
| `male` | 24 | 70.6% | **缺** | object |
| `blue` | 22 | 64.7% | 蓝色 | color |
| `shirt` | 18 | 52.9% | 衬衫 | object |
| `green` | 13 | 38.2% | 绿色 | color |
| `red` | 12 | 35.3% | 红色 | color |
| `yellow` | 12 | 35.3% | 黄色 | color |
| `people` | 9 | 26.5% | **缺** | object |
| `sleeve` | 9 | 26.5% | **缺** | object |
| `happy` | 7 | 20.6% | **缺** | object |
| `pink` | 7 | 20.6% | **缺** | color |
| `sitting` | 7 | 20.6% | **缺** | object |
| `adult` | 5 | 14.7% | **缺** | object |
| `food` | 5 | 14.7% | **缺** | object |
| `furniture` | 5 | 14.7% | **缺** | object |
| `indoors` | 4 | 11.8% | **缺** | object |
| `man` | 4 | 11.8% | **缺** | object |
| `shorts` | 4 | 11.8% | **缺** | object |
| `urban` | 4 | 11.8% | **缺** | color |
| `accessories` | 3 | 8.8% | **缺** | object |
| `bag` | 3 | 8.8% | **缺** | object |
| `black hair` | 3 | 8.8% | **缺** | object |
| `car` | 3 | 8.8% | 汽车 | object |
| `city` | 3 | 8.8% | **缺** | object |
| `cream` | 3 | 8.8% | **缺** | object |
| `dessert` | 3 | 8.8% | **缺** | object |
| `electronics` | 3 | 8.8% | **缺** | object |
| `female` | 3 | 8.8% | **缺** | object |
| `footwear` | 3 | 8.8% | **缺** | object |
| `hair` | 3 | 8.8% | **缺** | object |
| `handbag` | 3 | 8.8% | **缺** | object |
| `ice cream` | 3 | 8.8% | **缺** | object |
| `orange` | 3 | 8.8% | **缺** | color |
| `pants` | 3 | 8.8% | **缺** | object |
| `photography` | 3 | 8.8% | **缺** | object |
| `portrait` | 3 | 8.8% | **缺** | object |
| `shoe` | 3 | 8.8% | **缺** | object |
| `sliding` | 3 | 8.8% | **缺** | object |
| `smile` | 3 | 8.8% | **缺** | object |
| `transportation` | 3 | 8.8% | 交通工具 | object |
| `white` | 3 | 8.8% | 白色 | color |
| `architecture` | 2 | 5.9% | **缺** | object |
| `art` | 2 | 5.9% | **缺** | object |
| `baby` | 2 | 5.9% | **缺** | object |
| `christmas` | 2 | 5.9% | **缺** | object |
| `christmas decorations` | 2 | 5.9% | **缺** | object |
| `computer` | 2 | 5.9% | **缺** | object |
| `cup` | 2 | 5.9% | **缺** | object |
| `festival` | 2 | 5.9% | **缺** | object |
| `girl` | 2 | 5.9% | **缺** | object |
| `lake` | 2 | 5.9% | 湖水 | scene |
| `pajamas` | 2 | 5.9% | **缺** | object |
| `plant` | 2 | 5.9% | **缺** | object |
| `road` | 2 | 5.9% | **缺** | object |
| `street` | 2 | 5.9% | **缺** | object |
| `table` | 2 | 5.9% | **缺** | object |
| `text` | 2 | 5.9% | **缺** | object |
| `advertisement` | 1 | 2.9% | **缺** | object |
| `baby laughing` | 1 | 2.9% | **缺** | object |
| `baseball cap` | 1 | 2.9% | **缺** | object |
| `bowl` | 1 | 2.9% | **缺** | object |
| `box` | 1 | 2.9% | **缺** | object |
| `building` | 1 | 2.9% | **缺** | object |
| `bus` | 1 | 2.9% | **缺** | object |
| `cap` | 1 | 2.9% | **缺** | object |
| `chair` | 1 | 2.9% | **缺** | object |
| `christmas tree` | 1 | 2.9% | **缺** | object |
| `computer hardware` | 1 | 2.9% | **缺** | object |
| `conversation` | 1 | 2.9% | **缺** | object |
| `cutlery` | 1 | 2.9% | **缺** | object |
| `desk` | 1 | 2.9% | **缺** | object |
| `disposable cup` | 1 | 2.9% | **缺** | object |
| `family` | 1 | 2.9% | **缺** | object |
| `fountain` | 1 | 2.9% | **缺** | scene |
| `foyer` | 1 | 2.9% | **缺** | object |
| `grass` | 1 | 2.9% | **缺** | object |
| `handicraft` | 1 | 2.9% | **缺** | object |
| `hardware` | 1 | 2.9% | **缺** | object |
| `hat` | 1 | 2.9% | **缺** | object |
| `icing` | 1 | 2.9% | **缺** | object |
| `laptop` | 1 | 2.9% | **缺** | object |
| `leaf` | 1 | 2.9% | **缺** | object |
| `lego set` | 1 | 2.9% | **缺** | object |
| `machine` | 1 | 2.9% | **缺** | object |
| `monitor` | 1 | 2.9% | **缺** | object |
| `nature` | 1 | 2.9% | 自然 | scene |
| `number` | 1 | 2.9% | **缺** | object |
| `outdoors` | 1 | 2.9% | 户外 | scene |
| `paint container` | 1 | 2.9% | **缺** | object |
| `painting` | 1 | 2.9% | **缺** | object |
| `park` | 1 | 2.9% | **缺** | object |
| `pc` | 1 | 2.9% | **缺** | object |
| `performer` | 1 | 2.9% | **缺** | object |
| `purple` | 1 | 2.9% | **缺** | color |
| `romantic` | 1 | 2.9% | **缺** | object |
| `screen` | 1 | 2.9% | **缺** | object |
| `soft serve ice cream` | 1 | 2.9% | **缺** | object |
| `solo performance` | 1 | 2.9% | **缺** | object |
| `spoon` | 1 | 2.9% | **缺** | object |
| `standing` | 1 | 2.9% | **缺** | object |
| `student` | 1 | 2.9% | **缺** | object |
| `symbol` | 1 | 2.9% | **缺** | object |
| `tablet computer` | 1 | 2.9% | **缺** | object |
| `toy` | 1 | 2.9% | **缺** | object |
| `triumphant` | 1 | 2.9% | **缺** | object |
| `walking` | 1 | 2.9% | **缺** | object |
| `waterfront` | 1 | 2.9% | **缺** | scene |
| `wedding proposal` | 1 | 2.9% | **缺** | object |
| `wheel` | 1 | 2.9% | **缺** | object |
| `woman` | 1 | 2.9% | **缺** | object |
| `working out` | 1 | 2.9% | **缺** | object |
