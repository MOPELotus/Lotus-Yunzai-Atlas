# 旧图鉴首版覆盖报告

已有原始响应检查点时，可离线生成 JSON 覆盖报告。第一个参数指向含 `data/map.json` 的完整旧导出，第二个参数指向 `acquire-legacy-indexes.ts` 与 `acquire-legacy-record.ts` 使用的检查点目录。

```sh
bun plugins/atlas/legacy-coverage.ts /path/to/legacy-export /path/to/checkpoints > coverage.json
```

报告中的 `expected` 依据本地旧导出，`pinned` 统计已有独立固定来源和 SHA-256 的对象，`verified` 统计当前检查点已复核的原始字节，`missing` 为期望数减去已复核数。三个游戏固定版的公开索引回放可覆盖全部 29 类、6,055 个条目。2,989 份独立详情与 6,221 张独立原图是旧导出库存。基准回放包含 4 份详情和 31 张原图，原神成就的已获原图会另计到同一报告。单张原图可用于多类条目，总计按原图库路径、固定 URL 和哈希去重。

| 原材料 | 初始化所需目录 |
| --- | --- |
| 29 个固定版原索引 | `data/map.json` 中的 `games.<game>.locales.zh.pages.<page>`，每条 `path` 指向 `data/items/` 下相应记录 |
| 固定版原详情 | 对应条目 JSON 的 `content.detail`。`mappedRecords` 给出旧路径、原 URL、SHA-256 和检查点文件名 |
| 固定版原索引行 | 对应条目 JSON 的 `content.list`。对象键或数组下标对应旧 `recordId` |
| 原图 | 报告中的 `gallery/` 目标路径与 `meta.images` 对应，`references` 保留字段路径和源字段值 |
| 已登记占位图 | 140 次旧引用共用 `gallery/_placeholder/unknown.svg`，独立于 6,221 个原图文件统计 |

星铁末日、异相、虚构的源详情子路径分别是 `boss`、`peak`、`story`，图库由对应记录的敌人关联补足。原始检查点必须留存字节。后续包装条目 JSON 时，须保留超出 JS 安全整数的原始数字词法，例如末日 3022 的 `3513447881416968543`。直接用 `JSON.parse` 和 `JSON.stringify` 会舍入这个值。

`initialize-atlas.ts` 接收完整的 `data/` 与 `gallery/`；发布器将它们保存为 `snapshots/<版本>/data` 与同级 `gallery`，`current` 指向该版 `data`。覆盖报告只读，详情与原图有缺口时仍可输出报告供下一批补全。报告使用的检查点目录不能直接作为初始化来源。

## 初始化已有旧导出

首次升级可只读使用 `plugins/Lotus-Plugin/data/atlas/` 或 `plugins/Lotus-ReFactor/data/atlas/` 中已有的单份导出。设置 `LOTUS_ATLAS_DATA_DIR` 时以所指定的 `data/` 为准。存在主目录的 `current` 或 `data/` 时按主目录读取，异常时保留主目录的既有行为。

要将已核对的完整旧版导出迁入新目录，在宿主根目录运行：

```sh
mkdir -p data/atlas
bun plugins/atlas/initialize-atlas.ts data/atlas
```

发现两份不同的旧导出时，在命令最后指定要迁入的导出根目录。根目录需要含 `data/map.json` 和 `gallery/`。原位置只读，校验通过后才在主目录发布快照。已有主数据时初始化会退出。

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

## 生成隔离的索引条目

```sh
bun plugins/atlas/prepare-indexed-only.ts /path/to/legacy-export /path/to/checkpoints
bun plugins/atlas/prepare-indexed-only.ts /path/to/legacy-export /path/to/checkpoints /path/to/new-staging
```

省略最后一个参数时只输出计划。指定新目录时，将七类的原索引行写入 `preview/data/items/` 对应旧目录，同时生成运行时 `map.json` 和单独的 `status.json`。索引行通过固定摘要和旧导出的逐记录内容核对。包装保留对象顺序、数字原始写法和旧记录 ID，`content.detail` 写为 `null`。

`status.json` 按分类记录字段类型和原图要求，并列出缺失路径、原 URL、SHA-256 与字节数。原神成就需 75 张原图，其余六类没有图库要求。预览只登记实际复核通过的图库文件。`publishable` 固定为 `false`，本目录供离线查询验收。

## 原神成就原图

```sh
bun plugins/atlas/acquire-legacy-achievement-art.ts /path/to/legacy-export /path/to/checkpoints 4
```

索引中的 `icon` 必须逐条对应旧图库的 75 个文件，整份路径、大小和 SHA-256 映射也须匹配已核对旧图库的固定摘要。下载限额为每次 0 至 8 张，`0` 只复核已有文件。CDN 图片路径不含版本，响应只有通过旧 WebP 大小、格式及 SHA-256 校验才会进入检查点。重新生成隔离预览即可使用本批原图。

## 第 123 期深境螺旋补充原图

第 12 层第 3 间上半的「历经百战的矮灵雕刻师」可由[当期实录](https://www.youtube.com/watch?v=EXbRiGhMLjc)核对。旧导出的敌人头像缺失，可将[HoYoWiki 的丘林原始 PNG](https://act-webstatic.hoyoverse.com/event-static-hoyowiki-admin/2026/08/03/71c24dd790c4fb4ead7003c4ad38f6d1_8199721012512592432.png)保存到持久主题目录的 `gallery/gi/UI_MonsterIcon_Karzelek_Tsereteli_01.png`。图鉴优先检查旧快照原路径，再检查主题目录。两处均要求 256 × 256 原图的 SHA-256 为 `74ae70bfdd1630f3134d559a5b53d94a28e6c2d45b183f8ddb81bbff896c30af`，未找到可验证原图时保留敌人名称。

## 第 125 期深境螺旋补充原图

第 12 层第 1 间上半的历经百战的虹彩史莱姆（敌人 ID `20012301`）已由[第 59 期阵容记录](https://wiki.biligame.com/ys/渊月螺旋/7.X)确认。[同期阵容卡](https://www.u7buy.com/blog/genshin-impact-spiral-abyss/)展示该形态所用头像，与 [HoYoWiki 的虹彩史莱姆条目](https://wiki.hoyolab.com/pc/genshin/entry/11052?lang=zh-cn)头像一致。HoYoWiki 原始 PNG 和 BWIKI 头像的字节相同。

旧导出没有该头像。敌人索引未提供该 ID 的原图时，可在持久主题目录下的 `gallery/gi/hoyowiki/11052.png` 放入[官方原始 PNG](https://act-webstatic.hoyoverse.com/event-static-hoyowiki-admin/2026/06/25/1d9f9f856a9593af362aebca541f15e7_3285614967934688327.png)。原图为 256 × 256，SHA-256 为 `694fab4aad6a86dd57bf8cf68488ea7e2d7c9942009d23934128701c7de64fcc`。默认持久目录是宿主的 `data/atlas/theme/`，可用 `LOTUS_ATLAS_THEME_DIR` 指定。快照内的同路径文件优先，两个位置均复核摘要。缺文件或摘要不符时，图鉴仍显示敌人名称。查询只读本地文件。

## 2026 年 11 月幻想真境剧诗第八幕

记录 31 的 `7.2` 和 `7.2.52` 数据都提供「历经百战的丘丘萨满」标题和美味汤锅机制，月谕第八幕的敌人预览为空。11 月 1 日的[月谕难度实录](https://www.youtube.com/watch?v=ctSzyhDDpl4&t=572s)和[同期游戏内讨伐截图](https://staticg.sportskeeda.com/editor/2026/11/bc488-17935387674989-1920.jpg)确认该首领，游戏界面显示 Lv.95。头像与[丘尔德里克的 256 × 256 原图](https://patchwiki.biligame.com/images/ys/c/c4/6f12t7bek11qtfs2syx3yxlmfupfpcp.png)一致。

持久主题目录或快照的 `gallery/gi/verified/Churldric.png` 可放置该原图。图鉴只接受 SHA-256 为 `6d246e440e6f3e3890760a329a1703fca7e382189de2757bb95e04a585edc161` 的文件，缺图仍显示第八幕首领名称和原说明。

## 十月幻想真境剧诗首领补全

记录 30 的已实装十月月谕数据保留第六、八幕标题与机制，但敌人预览为空。以[当期月谕实录第六幕](https://www.youtube.com/watch?v=20KjpqXJbKw&t=517s)及[第八幕](https://www.youtube.com/watch?v=20KjpqXJbKw&t=680s)核对历经百战的嵌合兽怪箭士和嵌合翼骏狮。两张原头像已经在旧快照的第 124 期深境使用，分别为 `gallery/gi/UI_MonsterIcon_Volkodlak_Greyhound_Furiosa.webp` 和 `gallery/gi/UI_MonsterIcon_Chimera_Manticore.webp`。图鉴沿用旧快照的等级和机制，缺图时显示敌人名称。

## 角色总览原画

角色总览优先从 `LOTUS_CHARACTER_GALLERY_DIR` 的 `gs-character/`、`sr-character/` 或 `zzz-character/` 选择同角色原画。支持角色名文件、角色名子目录，遇到坏图继续尝试同角色候选。未匹配指定图库时，原神与星铁继续读取已安装主题的角色图库，绝区零读取旧资源的 `images/panel/`，再按原图鉴的同角色立绘与头像回退。普通同名记录保持各自原图，开拓者和三月七按已核对的性别与命途目录选图。

## 装备旧指令和别名

旧版会为武器、光锥和音擎的准确名称生成可省略「图鉴」的捷径。宿主只对相应游戏的唯一装备记录处理裸捷径。武器和光锥的别名分别摘自固定版 Miao-Plugin 的 [原神武器表](https://github.com/MOPELotus/miao-plugin/blob/2860761836069af80bacee5cb85b6dd2e91ea0b0/resources/meta-gs/weapon/alias.js) 和 [星铁光锥表](https://github.com/MOPELotus/miao-plugin/blob/2860761836069af80bacee5cb85b6dd2e91ea0b0/resources/meta-sr/weapon/alias.js)，按各自分类中的名称核对。原许可随附于 [LICENSES/Miao-Plugin-MIT.txt](../LICENSES/Miao-Plugin-MIT.txt)。

光锥叠影沿用游戏文本的格式占位。整数占位向零截断，带小数位的占位保留来源指定精度。嘉果的整数回能和同一种心情的整数治疗加成按游戏图鉴显示，「片刻，留在眼底」保留 0.36% 等两位小数。此规则仅用于星铁光锥叠影。
