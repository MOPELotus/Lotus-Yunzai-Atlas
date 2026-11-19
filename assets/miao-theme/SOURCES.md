# 原版图鉴素材

角色图鉴沿用 Lotus-ReFactor `278a607f564dc9e468e178918268c65ab2bfb51a` 的 `core/render/atlas-pages.js`。原背景对应 Miao-Plugin `1988f546f1972fd3911ca15fc1259184709f876b` 的 `resources/common/bg/bg-*.webp`，面板纹理取自同一版本的 `resources/common/cont/card-bg.png`。

主题默认从宿主的 `data/atlas/theme/` 读取，找不到素材时再读模块内的 `assets/miao-theme/`。使用托管更新前，可把已有的 `bg/`、`card-bg.png`、已获授权的 `fonts/` 和可选的 `relic-parts/`、`portraits/` 放到 `data/atlas/theme/`，该目录会随宿主数据保留。放置后重启宿主读取新路径。

设置 `LOTUS_ATLAS_THEME_DIR` 可指定主题目录，例如 Lotus-ReFactor 的 `resources/miao-theme/`。指定后使用该目录。`fonts/` 下支持 `HYWH-65W.ttf` 和 `MiSans-VF.ttf`。MiSans 由小米提供，汉仪文黑由汉仪字库提供。

星铁套装优先使用图鉴快照已记录的部件图。旧 Lotus-ReFactor 的 `resources/miao-theme/relic-parts/index.json` 与对应本地图片可补足快照未收录的部件。图缺失时保留快照中的部件名称。

原神角色沿用旧 Lotus-ReFactor 的 `resources/miao-theme/portraits/index.json` 和对应立绘。没有已登记立绘时用快照中的角色图。

图片和字体由使用者按各自许可从本地部署提供。发布仓库保存绘图实现与来源说明。

- [Miao-Plugin 固定版本素材说明](https://github.com/yoimiya-kokomi/miao-plugin/blob/1988f546f1972fd3911ca15fc1259184709f876b/README.md#L85-L89)
- [小米 MiSans 许可](https://hyperos.mi.com/font/en/download/)
- [汉仪文黑 65W](https://www.hanyi.com.cn/productdetail?id=990)
