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
