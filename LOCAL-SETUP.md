# 本地部署说明（GreenMountainTeam / floorplan-3d）

本目录源自 [wy51ai/floorplan-3d](https://github.com/wy51ai/floorplan-3d)（MIT，原作者 wuyi），
是 `GreenMountainTeam` 项目组下的第三个独立子项目（与 `layout-designer`、`room-designer` 并列），
现维护在 [flew0214/floorplan-3d](https://github.com/flew0214/floorplan-3d)。

上游是**零构建**应用：整个应用就是一个 `index.html`，原生 HTML/CSS/JS + Three.js r160，
不需要 npm install、不需要打包。

---

## 运行

**推荐双击 `启动.bat`（Windows）**，或用跨平台的 `start.py`：

```bash
cd floorplan-3d
python start.py          # 默认 8123 端口；端口被占用会自动往后找
python start.py 9000     # 指定端口
```

启动器会起一个本地静态服务器并自动打开浏览器。等价的其它方式：

```bash
python -m http.server 8123   # 然后自己打开 http://127.0.0.1:8123/index.html
npx serve .                  # Node 环境
```

也可以直接双击 `index.html`（`file://`），此时 three.js 会回退到 CDN 加载——
见下面「协议自适应 importmap」一节。

无需 `npm install`。所有第三方依赖已经 vendor 到本地（见下）。

---

## 协议自适应 importmap（相对上游的主要差异）

上游 `index.html` 用**静态** importmap，Three.js 固定走 jsDelivr CDN：

```html
"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
"three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
```

国内访问 jsDelivr 不稳定，且首次打开 3D 场景必须联网。本地改为**动态**注入 importmap，
按协议自动选择依赖来源：

```js
var LOCAL = {three:'./vendor/three/three.module.js', 'three/addons/':'./vendor/three/addons/'};
var CDN   = {three:'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
             'three/addons/':'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/'};
// file:// → CDN，http(s):// → 本地 vendor
```

**为什么 `file://` 必须用 CDN：** 浏览器把每个 `file:` 文档当作独立源（origin 为 `null`），
会用 CORS 策略禁止 `file://` → `file://` 的 ES module 导入——**本地 vendor 文件也一样被拦**。
上游的 CDN 能工作，是因为 jsDelivr 响应带 `Access-Control-Allow-Origin: *`，能匹配 `null` origin。

> 实测（Chrome 126）：
> | 打开方式 | 依赖来源 | `window.View3D` | 结果 |
> | --- | --- | --- | --- |
> | `file://` | CDN | `object` | 3D 正常（需联网） |
> | `http://` | 本地 vendor | `object` | 3D 正常（完全离线，零外部请求） |
>
> 如果只把静态 importmap 指向本地 vendor，`file://` 下 6 个模块会被 CORS 全部拦截，
> 点「3D 场景」只会弹提示、什么都不发生。

### vendor 目录内容

来源：`npm pack three@0.160.0`（精确版本，非 CDN 实时内容）。

```
vendor/three/
├── three.module.js          # three r160 主模块（自包含，无嵌套 import）
├── LICENSE                  # three 的 MIT 许可证（再分发必须保留）
└── addons/
    ├── controls/OrbitControls.js
    ├── controls/PointerLockControls.js
    ├── geometries/RoundedBoxGeometry.js
    ├── environments/RoomEnvironment.js
    └── renderers/CSS2DRenderer.js
```

这 5 个 addon 只依赖 `three` 本体，彼此无嵌套依赖，因此**只 vendor 这 6 个文件即可**，
无需引入整个 three 包（完整包解压后体积是这里的几十倍）。

> 目录刻意**不使用 `build/` 这一层**：上游 `.gitignore` 里有 `build/`，会把
> `vendor/three/build/` 整体忽略掉，导致依赖文件无法入库。

---

## 方案存储（容易踩的坑）

方案存在 `localStorage` 的 `huxing-design-v1` 键里，而 **localStorage 按「协议 + 域名 + 端口」隔离**：

- `file:///E:/.../index.html` 与 `http://127.0.0.1:8123/index.html` 是**两个不同的存储空间**
- 同一个 `file://` 页面，Chrome 里所有 `file:` 文档还可能共享同一个存储空间

所以「换了打开方式，家具就没了」是**换了个存储空间**，不是数据丢了。
同理，在 `file://` 下点了「清空布置」，会一直保存为空方案，直到你点「文件 → 重置为默认方案」。

界面内恢复默认：**文件 ▾ → 重置为默认方案**（可撤销）。

---

## 户型编辑器（内置）

户型几何不再写死在代码里。顶栏多了一个 **「户型」按钮**（快捷键 `P`），进入后可以直接在
2D 平面图上改户型，改完 3D 立即重建。

### 能做什么

| 操作 | 怎么用 |
| --- | --- |
| 新建房间 | 左侧「房间」→ 在平面上拖出一个矩形 |
| 新建墙体 | 左侧「墙体」→ 拖出一条线（自动对齐水平 / 垂直，Shift 反向） |
| 开窗 / 开门 | 左侧「窗」/「门」→ 点击一段墙体 |
| 改房间尺寸 | 点选房间 → 拖角点 / 边中点手柄，或在右侧直接填「开间 / 进深」 |
| 改墙体 | 点选墙体 → 改类型（承重 / 外墙 / 可拆 / 矮墙）、长度、厚度 |
| 改窗 / 门 | 点选 → 改长度、窗台高 |
| 删除元素 | 右侧属性面板「删除 XX」 |
| 恢复默认户型 | 左侧「重置为默认户型」 |

### 几点行为说明

- **房间改尺寸时，贴着它的墙会跟着走**（可在右侧「户型选项」里关掉）。
  只带动与该边「基本重合」的那段墙（重叠需过半），避免误带动只擦到一角的墙；
  墙是**整段平移**，厚度不变（不会被拉厚）。
- **非矩形房间**（L 形的餐厅、过道等）只能整体移动，不能拖手柄改尺寸——需要改尺寸就删掉重画。
- **房间多边形与墙体是两套独立数据**：房间决定地板与面积，墙体决定 3D 里的墙。
  编辑器**不会自动帮你造墙**，新增房间后需要自己补上周围的墙与门窗。
- 户型数据存在 `state.plan`，随方案一起**撤销 / 重做、保存到 localStorage、导入导出 JSON**。
- 切到 3D 可以直接看效果。3D 下左侧仍是家具库（方便在 3D 里摆家具），
  按 `T` 切回 2D 会继续回到户型编辑状态，右侧仍显示选中房间的属性。

### 数据落点

| 位置 | 内容 |
| --- | --- |
| `index.html` | `DEFAULT_ROOMS / DEFAULT_WALLS / DEFAULT_WINS / DEFAULT_DOORS / DEFAULT_SLIDES`（默认户型常量）、`defaultPlan()` / `applyPlan()`（与 `state.plan` 同步）、`PLAN_HOOK`（指针接管钩子） |
| `plan-editor.js` | 编辑器本体（新增文件，普通 `<script>`，`file://` 下也能加载） |

> `ROOMS / WALLS / WINS / DOORS / SLIDES` 在 `index.html` 里已从 `const` 改为 `let` 指针，
> 指向 `state.plan` 中对应的数组，因此上游原有的全部读取点无需改动。
> 与上游合并时，冲突点集中在：默认户型常量、`defaultPlan/applyPlan`、`renderAll` 开头、
> `WINS` 的台高字段、3D 侧 `bayLintels / planSpan / setOrigin` 这几处。

---

## Git 远程与上游更新

remote 按 fork 惯例配置：

| remote | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `flew0214/floorplan-3d` | 本项目自己的仓库，推送目标 |
| `upstream` | `wy51ai/floorplan-3d` | 原作者仓库，用于跟进上游更新 |

拉取上游更新：

```bash
cd floorplan-3d
git fetch upstream
git log --oneline HEAD..upstream/master   # 看上游有什么新提交
git merge upstream/master                 # 合并
```

**合并时唯一可能冲突的位置**就是上面那段 importmap 代码块（动态注入那段）。
如果上游又改了 CDN 地址，合并后按本文件「协议自适应 importmap」一节确认两套地址都还在即可。

vendor 目录不随上游更新，需要 three 升版本时手动重来一次：

```bash
npm pack three@<版本号> --pack-destination <临时目录>
tar -xzf <临时目录>/three-<版本号>.tgz -C <临时目录>
# 覆盖 vendor/three/three.module.js 与 vendor/three/addons/... 后同步改 index.html 里 CDN 那份地址
```

---

## 许可

- 本项目源自 `wy51ai/floorplan-3d`：**MIT**，Copyright (c) 2026 wuyi
  （本仓库为 fork，保留原作者版权声明与许可证全文）
- Three.js r160：**MIT**，Copyright (c) 2010-2023 three.js authors

两者均允许使用、修改、再分发与商用，条件是保留版权声明与许可证全文。
`vendor/three/LICENSE` 已随依赖一起保留。**注意 MIT 许可与本项目组
`room-designer` / `layout-designer` 所用的 AGPL-3.0 是两套独立协议**——
本目录作为独立子项目不涉及 AGPL 代码的混合分发；若后续要把本项目代码
合并进 AGPL 项目，需另行评估协议义务。

---

## 功能速览（来自上游 README）

- **2D 平面**：按原始户型比例显示，单位 mm；60+ 种家具家电可拖入；移动/旋转/改尺寸；
  贴墙自动吸附；测量工具；拆改非承重墙（承重墙单独标示）；图层开关
- **3D 场景**：鸟瞰/斜视/俯视多种视角；第一人称漫游（桌面 WASD + 触屏虚拟摇杆，可开关门）；
  全高墙/剖切墙切换；日照时间滑块；夜景灯光；精细家具模型（柜门分缝、软包床头、
  金属陶瓷环境反射）；3D 中可直接选中拖动家具，与 2D 方案实时同步
- **方案与统计**：房间面积与套内面积统计；按房间更换地面材料并按面积 +5% 损耗估算造价；
  撤销/重做；方案自动存 localStorage；简中/繁中/EN 三语切换；导出 PNG、导出/导入方案 JSON

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `T` | 切换 2D / 3D |
| `V` / `M` / `X` | 选择 / 测量 / 拆改墙体 |
| `R` / `Shift+R` | 选中家具顺/逆时针旋转 90° |
| `Delete` / `Backspace` | 删除选中家具 |
| `Ctrl/⌘ + D` | 复制选中家具 |
| `Ctrl/⌘ + Z`，`Ctrl/⌘ + Shift + Z` | 撤销 / 重做 |
| `F` | 适应窗口 |
| `+` / `-` | 放大 / 缩小 |
| `[` / `]` | 展开/收起左侧家具库、右侧面板 |
| `Shift + F` | 全屏 |
| `Esc` | 取消当前操作 |
| 漫游 | `WASD` / 方向键移动，`Shift` 疾走，`E` 开关门 |
