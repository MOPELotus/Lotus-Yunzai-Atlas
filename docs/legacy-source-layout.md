# 旧图鉴首版覆盖报告

已有原始响应检查点时，可离线生成 JSON 覆盖报告。第一个参数指向含 `data/map.json` 的完整旧导出，第二个参数指向 `acquire-legacy-indexes.ts` 与 `acquire-legacy-record.ts` 使用的检查点目录。

```sh
bun plugins/atlas/legacy-coverage.ts /path/to/legacy-export /path/to/checkpoints > coverage.json
```

报告中的 `expected` 依据本地旧导出，`pinned` 统计已有独立固定来源和 SHA-256 的对象，`verified` 统计当前检查点已复核的原始字节，`missing` 为期望数减去已复核数。三个游戏固定版的公开索引回放可覆盖全部 29 类、6,055 个条目。2,989 份独立详情与 6,221 张独立原图是旧导出库存。已核实的公开回放目前覆盖其中 4 份详情和 31 张原图。单张原图可用于多类条目，总计按原图库路径、固定 URL 和哈希去重。

| 原材料 | 初始化所需目录 |
| --- | --- |
| 29 个固定版原索引 | `data/map.json` 中的 `games.<game>.locales.zh.pages.<page>`，每条 `path` 指向 `data/items/` 下相应记录 |
| 固定版原详情 | 对应条目 JSON 的 `content.detail`。`mappedRecords` 给出旧路径、原 URL、SHA-256 和检查点文件名 |
| 固定版原索引行 | 对应条目 JSON 的 `content.list`。对象键或数组下标对应旧 `recordId` |
| 原图 | 报告中的 `gallery/` 目标路径与 `meta.images` 对应，`references` 保留字段路径和源字段值 |
| 已登记占位图 | 140 次旧引用共用 `gallery/_placeholder/unknown.svg`，独立于 6,221 个原图文件统计 |

星铁末日、异相、虚构的源详情子路径分别是 `boss`、`peak`、`story`，图库由对应记录的敌人关联补足。原始检查点必须留存字节。后续包装条目 JSON 时，须保留超出 JS 安全整数的原始数字词法，例如末日 3022 的 `3513447881416968543`。直接用 `JSON.parse` 和 `JSON.stringify` 会舍入这个值。

`initialize-atlas.ts` 接收完整的 `data/` 与 `gallery/`；发布器将它们保存为 `snapshots/<版本>/data` 与同级 `gallery`，`current` 指向该版 `data`。覆盖报告只读，详情与原图有缺口时仍可输出报告供下一批补全。报告使用的检查点目录不能直接作为初始化来源。

## 详情候选队列

```sh
bun plugins/atlas/legacy-detail-queue.ts /path/to/legacy-export /path/to/checkpoints
bun plugins/atlas/capture-legacy-details.ts /path/to/legacy-export /path/to/checkpoints /path/to/detail-candidates 2 hsr/maze_boss/3020 hsr/maze_boss/3021
```

队列要求 29 个索引均通过固定 SHA-256 复核，旧导出的条目 ID 集合须逐类相符。详情的游戏版本取自固定索引和原站路径。只有星铁末日幻影中旧详情带精确 `id` 和 `name`、且名称与固定索引一致的未固定条目进入候选。3024 缺名称，保留人工核对。其他类别目前只报告已知路径和待核对状态。

每次最多请求 8 份详情，`0` 仅复核现有候选。候选文件含原响应字节的 Base64、原 URL 和本次计算的 SHA-256。重复运行复用经 SHA-256、身份和结构复验的候选。若不同响应通过同一条目身份校验，保留各自的摘要并报告冲突。候选与独立固定检查点分开，覆盖报告和发布入口只使用独立核实的材料。

## 候选与旧导出复核

```sh
bun plugins/atlas/review-legacy-details.ts /path/to/legacy-export /path/to/checkpoints hsr/maze_boss/3021 /path/to/record.candidate.json
bun plugins/atlas/review-legacy-details.ts /path/to/legacy-export /path/to/checkpoints --indexed-only
```

详情复核报告独立旧详情摘要、候选原始响应 SHA-256 以及带 JSON Pointer 的差异。旧详情摘要对对象键排序，同时保留所有原数字词法。候选摘要来自校验并解码后的原始响应字节。末日 3020 与 3021 各有 9 个 `stage_name` 尾数差异，其旧值均符合 JS 整数舍入，状态为 `legacy-integer-rounding`，仍属候选。

`--indexed-only` 比较旧 `content.list` 与已固定原索引行。三款游戏的成就以及星铁 `monstervalue`、`EliteGroup`、`HardLevelGroup` 和 `InfiniteEliteGroup` 都没有独立详情请求，这七类在核实的旧导出中共 3,066 条。复验报告按类显示实测相符行数，不计入独立详情覆盖。
