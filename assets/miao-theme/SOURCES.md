# 原版图鉴素材

角色图鉴沿用 Lotus-ReFactor `278a607f564dc9e468e178918268c65ab2bfb51a` 的 `core/render/atlas-pages.js`。原背景对应 Miao-Plugin `1988f546f1972fd3911ca15fc1259184709f876b` 的 `resources/common/bg/bg-*.webp`，面板纹理取自同一版本的 `resources/common/cont/card-bg.png`。

主题依次从宿主的 `data/atlas/theme/`、模块内的 `assets/miao-theme/` 和旧部署 `plugins/Lotus-ReFactor/resources/miao-theme/`、`plugins/Lotus-Plugin/resources/miao-theme/` 读取。公开首装的图鉴下载只准备数据与原词条图片。启动入口也检查原主题，从已有的本地部署恢复已核对的九个背景、标题纹理和两份字体。恢复只补齐缺失文件，原文件以固定提交的文件摘要核验。宿主持久目录中的已有文件仍然优先。

独立迁移时，部署者可以用 `LOTUS_ATLAS_THEME_SOURCE_DIR` 指定已获授权的旧版 `resources/miao-theme/` 目录供本地恢复。也可把已获授权的主题文件及可选的 `relic-parts/`、`portraits/` 放到 `data/atlas/theme/`。该目录会随宿主数据保留。没有可用本地来源时，图鉴仍可使用，补齐文件后重启即可再次检查。

设置 `LOTUS_ATLAS_THEME_DIR` 可指定唯一使用的主题目录，例如 Lotus-ReFactor 的 `resources/miao-theme/`。此目录仅供读取。`fonts/` 下支持 `HYWH-65W.ttf` 和 `MiSans-VF.ttf`。旧布局也从主题旁的 `fonts/` 读取 MiSans。MiSans 由小米提供，汉仪文黑由汉仪字库提供。

固定旧模板按属性选背景。原神和星铁沿用各属性的文件，绝区零艾莲等冰属性角色沿用同一原冰底图。旧模板的无属性默认底图是 `bg-sr.webp`。

星铁套装优先使用图鉴快照已记录的部件图。旧 Lotus-ReFactor 的 `resources/miao-theme/relic-parts/index.json` 与对应本地图片可补足快照未收录的部件。图缺失时保留快照中的部件名称。

原神角色沿用旧 Lotus-ReFactor 的 `resources/miao-theme/portraits/index.json` 和对应立绘。没有已登记立绘时用快照中的角色图。

图片和字体由使用者按各自许可从本地部署提供。发布仓库保存绘图实现与来源说明。

- [Miao-Plugin 固定版本素材说明](https://github.com/yoimiya-kokomi/miao-plugin/blob/1988f546f1972fd3911ca15fc1259184709f876b/README.md#L85-L89)
- [小米 MiSans 许可](https://hyperos.mi.com/font/en/download/)
- [汉仪文黑 65W](https://www.hanyi.com.cn/productdetail?id=990)
