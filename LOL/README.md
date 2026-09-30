# LOL 皮肤拼图工坊

把腾讯《英雄联盟》官方皮肤库（`skins.js`）整理成本地数据集，下载全部皮肤原画到本地，
并提供一个纯前端页面：**上传你的账号数据 → 判断你拥有哪些皮肤/炫彩与品质 → 生成网格长图或海报式拼图 → 导出 PNG**。

---

## 快速开始

```bash
# 1) 整理数据（从 data/raw/*.js 生成结构化数据集）
python tools/organize_data.py

# 2) 下载全部图片到本地（约 9150 张 / 800 MB）
python tools/download_images.py --workers 16     # 原皮肤+皮肤 loadingImg、炫彩 chromaImg
python tools/download_icons.py                   # 60x60 图标（可选，海报背景用）

# 3) 起本地服务器并打开页面
python tools/serve.py
#   -> http://127.0.0.1:8777/web/
```

> 必须用 `tools/serve.py` 打开，不要直接双击 `index.html`：
> `file://` 下浏览器会用 CORS 拦掉 `fetch()` 读本地 JSON，canvas 也会被"污染"导致无法导出 PNG。

---

## 数据规模（当前版本 16.19）

| 项目 | 数量 | 图片源 |
|---|---|---|
| 英雄 | 173 | — |
| 原皮肤 | 173 | `loadingImg` 308×560 竖版原画 |
| 皮肤 | 1953 | `loadingImg` 308×560 竖版原画 |
| 炫彩 | 7032 | `chromaImg` 270×303 PNG 立绘 |
| **合计** | **9158** | 已本地化 9154 张（4 张腾讯 CDN 404） |

已排除 40 条 `heroId=0` 的「经典 XX」旧版残留皮肤（无 `loadingImg`、不属于任何英雄）。

---

## 目录结构

```
LOL/
├─ data/
│  ├─ raw/                 skins.js / hero_list.js 原始文件
│  │  └─ archive/          历次同步前的旧文件备份（可回滚）
│  ├─ custom_skins.json    （可选）手动补充的皮肤，会被合并进数据集
│  ├─ pending.patch.json   （可选）后台生成的差异清单，供 sync.py 参考
│  ├─ last_sync.json       最近一次同步的差异记录
│  ├─ heroes.json          173 个英雄（含拼音 keywords、定位、皮肤数）
│  ├─ skins.json           2126 条 原皮肤+皮肤（含 loadingImg/mainImg/centerImg/iconImg）
│  ├─ chromas.json         7032 条 炫彩（含 parentId 挂回父皮肤、chromaImg）
│  ├─ manifest.json        全部图片任务（含 big/center/icon 等备选图源）
│  ├─ primary.json         skinId -> 拼图主图地址
│  ├─ images.json          skinId -> 本地图片相对路径（页面靠它找图）
│  ├─ icons.json           skinId -> 本地 60×60 图标路径
│  ├─ meta.json / stats.json   版本与统计
│  └─ download_failed.json 下载失败清单
├─ images/
│  ├─ {heroId}/{skinId}.{jpg|png}    皮肤原画 / 炫彩立绘
│  └─ icons/{heroId}/{skinId}.jpg    小图标
├─ web/                    index.html + admin.html + style.css + core.js + app.js（无第三方依赖）
└─ tools/
   ├─ organize_data.py     数据整理（合并 custom_skins.json）
   ├─ sync.py              同步官方最新数据（归档 + 差异 + 重建 + 增量下图）
   ├─ build_all.py         一条命令跑完整流水线
   ├─ download_images.py   原画批量下载（支持 --limit/--only/--retry/--manifest）
   ├─ download_icons.py    图标批量下载
   ├─ serve.py             本地静态服务器（禁用缓存，--verbose 记录图片请求）
   ├─ cdp.mjs              无头浏览器驱动（开发自测用）
   └─ probe.mjs            多场景回归自测
```

---

## 页面功能

### 皮肤图鉴
173 个英雄的 2126 款皮肤全量浏览，支持英雄名/皮肤名/拼音缩写搜索（如 `yn`、`anni`）、
按英雄顺序/炫彩数量/名称排序、只看带炫彩。点任意卡片在下方展开该皮肤的全部炫彩。

### 我的皮肤
上传账号数据文件，**全部在浏览器本地解析，不上传任何服务器**。

#### 已适配的官方导出格式（`Getskin.js` 一类）

实测文件结构：

```jsonc
{
  "result": { "error_code": 0, "error_message": "success" },
  "championSkins": [
    {
      "id": 101,                     // heroId
      "skins": [
        { "id": 101002, "create_time": "1630746527", "chromas": 0 },   // 普通皮肤
        { "id": 101008, "create_time": "1766583613", "chromas": 1 }    // 这一条本身是炫彩
      ]
    }
  ],
  "champion_num": 173, "skin_num": 1623
}
```

解析时踩到的几个要点（都已在代码里处理）：

- **`chromas` 是标志位不是数量**：`1` 表示这一条本身就是炫彩条目，`0` 表示普通皮肤。
  实测验算：标注 `1` 的条目 374 条，**全部**命中本地 `chromas.json`；标注 `0` 的 1626 条**全部**命中 `skins.json`。
- **文件里没有"原皮肤"条目**（原皮肤随英雄赠送，不单独列出）。处理方式：该英雄只要有任意皮肤/炫彩入账，
  就推断其原皮肤也拥有（会明确标注"推断 N 个"，不混进付费皮肤数）。
- **炫彩能精确挂回父皮肤**：通过 `chromas.json` 的 `parentId`，所以"拥有哪 374 个炫彩"是精确的，
  不是估算——这也让"整套收齐"的统计（实测 40 款）是有意义的。
- **`create_time` 是获取时间戳**：用来做"最近获得"时间线（实测跨度 2021-02-14 ~ 2026-09-30）。
- 文件里的 `skin_num`（1623）与实际条目数（2000 = 1626 皮肤 + 374 炫彩）口径不同，以前者为准会少算。

**实测样例结果**（一份真实 173 英雄账号）：2000 条记录 **100% 命中**本地库、0 未匹配；
皮肤 1804（含 171 个原皮肤）、炫彩 374、评分 9569、等级「荣耀收藏家」、覆盖 171/173 英雄。

#### 其他格式（容错模式）
不是官方导出结构时，退回到通用解析：递归扫描 JSON，识别 `skinId / skin_id / id / skins[] / data / list …`
等常见字段，纯 id 列表、逗号分隔字符串、CSV 也能吃。

输出的判定结果：

- **皮肤总数 / 炫彩总数 / 收藏评分 / 账号等级**（新手上路 → 入门召唤师 → 活跃玩家 → 资深召唤师 → 荣耀收藏家）
- **品质分布**：终极 / 神话 / 至臻 / 传说 / 史诗 / 限定 / 普通（按名称关键词实测分类）
- **收藏完成度**：英雄覆盖、皮肤收集、炫彩收集、整套齐全
- **英雄收藏榜**：按评分排序，点开可看该英雄你拥有的全部皮肤与炫彩
- **最近获得**：按账号数据里的获得时间排序（仅官方导出格式带时间戳时出现）
- **缺失的皮肤**：按品质排序，看看还差哪些

> 评分口径：终极 100 / 神话 60 / 至臻 50 / 传说 30 / 史诗 12 / 限定 10 / 普通 0，每个炫彩 +1.5，
> 原皮肤 0 分。只上传炫彩 ID 也会自动标记为「拥有其父皮肤」。

### 拼图生成
- **数据来源**：我拥有的 / 按英雄分组合并 / 仅传说及以上 / 全图鉴（2126 款）
- **内容开关**：包含炫彩、包含原皮肤、按英雄分组、显示品质角标
- **版式**：列数 3–40、格子宽 120–300、导出倍率 1–3x、自定义标题/副标题
- **整齐网格长图**：按英雄分组平铺，卡片带品质描边与角标，导出 PNG；支持翻页
- **海报式拼图**：背景为收藏皮肤马赛克 + 精选 4 张横版大图 + 品质分布 + 英雄收藏榜 + 等级评分
- 生成后支持缩放预览、**翻页查看**、下载本页 / 下载全部页

### 分页：内容太多就拆成多页（而不是拒绝生成）

「分页」下拉框有三档行为：

| 选项 | 行为 |
|---|---|
| 自动（默认） | 先自动优化尺寸争取一页放下；确实放不下就自动按安全上限切分成多页 |
| 1 页 | 强制单页；放不下会提示需要减小格子宽 / 减少内容 |
| N 页 | 按指定页数**尽量均匀**切分（二分每页容量），并保证每页都不超限 |

- 分页时每页页头会标注「第 X / Y 页」，文件名形如 `我的皮肤收藏_第2页共3页.png`
- **按需渲染 + LRU 缓存**：只渲染当前页，最多缓存 3 页。全图鉴 47 页不会一次性占掉数 GB 内存
- 「下载全部页」会逐页渲染 → 导出 → 立即释放，内存始终只留一页
- 切分粒度是「英雄分组」：单个英雄的皮肤不会跨页断开；某英雄单独超过一页时按行拆开并标注「（续）」

### 大拼图的尺寸限制（重要）

浏览器画布单边硬上限是 **16384px**，而**一旦接近这个值，光栅化会把主线程钉死，表现为整页假死（CPU 归零、连截图都拍不出来）**。
所以本工具用更保守的安全上限 **12000px / 1.2 亿像素**，并在渲染前就拦下超限的请求：

- 内容偏多时先**自动缩小格子 / 增加列数**，再**自动降倍率**，并用右下角提示条告知做了什么调整
- 仍然放不下时自动分页；指定页数装不下会明确告诉你「最少需要 N 页」
- 实测：57 格约 0.4 秒；全图鉴 9158 张按 47 页切分，首屏约 1 秒可用

> 之所以把上限设成 12000 而不是 16384：这是本地实测踩出来的坑——超限时浏览器会**静默截断**画布，
> 而代码仍按原尺寸去 `fillRect`，于是触发一次同步巨幅光栅化，页面直接失去响应且无法恢复。

---

## 后台：新增英雄 / 皮肤怎么办

打开 **http://127.0.0.1:8777/web/admin.html**（前台顶栏也有入口），四块内容：

### 1. 当前数据状态
英雄 / 原皮肤 / 皮肤 / 炫彩 / 条目总数 / 已排除旧版残留 / 本地图片数 / 本地图标数，以及数据版本与生成时间。

### 2. 检查官方更新（真·一键）
浏览器直接读取腾讯官方 `skins.js` 与 `hero_list.js`（实测该 CDN 允许跨域），和本地逐条对比，列出：

- **新增英雄**（heroId / 称号 / 名字 / 别名 / 定位）
- **新增皮肤与炫彩**（skinId / 归属英雄 / 皮肤名 / 类型），新英雄的皮肤会标「新英雄」
- **官方已下架**的条目
- 自动忽略官方数据里那 40 条 `heroId=0` 的「经典 XX」旧版残留（构库时本就排除），不会误报

然后下载 `pending.patch.json`（差异清单）放进 `data/`，执行：

```bash
python tools/sync.py
```

`sync.py` 会：拉取最新官方数据 → 旧文件归档到 `data/raw/archive/*.bak`（可回滚）→ 打印新增/移除清单
→ 重建全部结构化数据 → 只下载新增图片 → 重试历史失败项。另外：

```bash
python tools/sync.py --dry-run      # 只看差异，不写任何文件
python tools/sync.py --no-download  # 只更新数据，不下图
```

### 3. 手动补充（官方接口还没有的条目）
填 heroId / skinId / 皮肤名 / 品质 / 图片地址 → 加入清单 → 下载 `custom_skins.json` 放进 `data/`。
重新整理数据时会自动合并，**不会被官方数据覆盖**；挂到官方还没有的 heroId 上会自动生成占位英雄。

### 4. 完整流程（日常更新就看这块）
```bash
# 最省事：一条命令跑完整条流水线
python tools/build_all.py --download --with-icons
```

**新英雄为什么"自动归位"？** 皮肤归属完全由官方数据里的 `skinId.heroId` 决定，
`heroes.json` 也只以 `hero_list.js` 为准；只要有新数据进来，前台图鉴、统计、拼图分组都会自动出现新英雄，
不需要改任何代码。官方 `hero_list.js` 里缺失但 `skins.js` 里存在的英雄也会被兜底补上占位。

---

## 开发自测

页面内置自检入口，配合 `tools/cdp.mjs`（零依赖 CDP 驱动）可以在无头浏览器里验证渲染，
不需要靠"截图猜时机"：

```bash
# 账号判定报告
node tools/cdp.mjs --url "http://127.0.0.1:8777/web/?selftest=me" --wait "window.__selftest==='done'"

# 真实文件上传（走 FileReader，等同用户手选文件）
node tools/cdp.mjs --url "http://127.0.0.1:8777/web/" \
  --upload "#file::C:\path\to\Getskin.js" \
  --wait "!document.querySelector('#report').hidden" \
  --eval "document.querySelector('#kpiSkin').textContent" --shot _shots/upload.png

# 网格长图（limit=N 取前 N 款皮肤，export=1 顺带验证 PNG 导出体积）
node tools/cdp.mjs --url "http://127.0.0.1:8777/web/?selftest=grid&limit=60&export=1" \
  --wait "window.__selftest==='done'" --eval "window.CollageCore.lastPerf" --shot _shots/grid.png

# 海报
node tools/cdp.mjs --url "http://127.0.0.1:8777/web/?selftest=poster" --wait "window.__selftest==='done'"

# 一次跑多个场景（含分页与尺寸守卫回归）
node tools/probe.mjs
```

自检模式会拦截 `alert/confirm`（无头环境里弹窗会永久阻塞主线程），并把各阶段写入 `window.__stage`。

---

## 已知限制

- 炫彩在官方数据里**只有 `chromaImg`**（270×303 方图，白底），没有竖版原画；拼图时按卡片比例居中裁剪。
- 4 张炫彩图在腾讯 CDN 上返回 404：`64070`（李青）、`82058`（莫德凯撒）、`99012`（拉克丝）、`103075`（阿狸）。
- 17 张 60×60 图标同样 404；页面在图片加载失败时会自动隐藏破图，不影响拼图。
- 品质分类基于皮肤名称关键词实测（官方 `skins.js` 的 `skinlabel` 字段全部为「无」，不可用）。
- 内存策略：渲染时按目标尺寸用 `createImageBitmap` 解码、画完即 `close()`，不留全尺寸位图；
  图鉴最多同时挂 240 张卡（超过则整段替换），否则上千张解码图会把渲染进程 OOM 掉。

## 数据来源

- 皮肤库：<https://game.gtimg.cn/images/lol/act/img/js/skins/skins.js>
- 英雄库：<https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js>
