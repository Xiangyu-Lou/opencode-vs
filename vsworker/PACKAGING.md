# 打包 VsWorker 桌面客户端 / Packaging the VsWorker desktop client

本文是 **macOS 与 Windows 桌面客户端**的完整打包手册：从把 skill / plugin / MCP 放进 bundle，到打出
`.dmg` / `.exe`，再到验证产物里确实带上了这些内容。

三份文档的分工：

| 文档                         | 管什么                                                  |
| ---------------------------- | ------------------------------------------------------- |
| [README.md](./README.md)     | `bundle.jsonc` 的字段语义、用户怎么开关、运行时加载顺序 |
| **PACKAGING.md**（本文）     | 怎么把这些东西打进 macOS / Windows 客户端               |
| [UPSTREAM.md](./UPSTREAM.md) | 合并上游时怎么不把 fork 的改动弄丢                      |

> `packages/desktop/README.md` 是上游遗留文件，里面的 `bun run build && bun run package` **不带 channel**，
> 照着跑只会打出 `dev` 通道、appId `ai.opencode.desktop.dev` 的 "VsWorker Dev"，不是可分发的 VsWorker。
> 以本文为准。

---

## 0. 先搞清楚产物链路

「打包」其实是两件事串起来：**先把 bundle 内容编译成代码**，**再把代码装进 Electron 壳子**。

```
vsworker/bundle.jsonc
  │   bun run --cwd vsworker bundle generate
  ▼
vsworker/src/{server,tui,mcp,skills}.gen.ts        ← skill 的文件内容在这里被内联成字符串字面量
  │   packages/opencode/src/{plugin/index.ts, config/config.ts, skill/index.ts, tool/shell.ts} 静态 import
  ▼
packages/opencode/dist/node/node.js                ← bun script/build-node.ts（由 desktop 的 prebuild 触发）
  │   electron-vite 的 virtual:opencode-server 插件把它拉进 main bundle
  ▼
packages/desktop/out/main/{index,sidecar}.js + out/main/chunks/node-*.js   ← 服务端落在 chunk 里
  │   npx electron-builder
  ▼
VsWorker.app / vsworker-desktop-win-x64.exe
```

三个必须记住的结论：

- **skill 不是以文件形式躺在 app 的资源目录里的。** 它的每个文件都被读成字符串写进
  `vsworker/src/skills.gen.ts` 的 `data:` 字段（见该文件顶部注释），编译进 JS。运行时才由
  `vsworker/src/skills.ts` 的 `materialize()` 解包到 `~/.cache/vsworker/vsworker/skills/<id>/` ——
  因为 skill 工具需要一个真实目录。plugin 是 `import * as m0 from "../plugins/hello/index.ts"`，
  MCP 是一段 JSON 常量，同理都编译进代码。
- **漏跑 `bundle generate`，产物里就没有你的改动。** 改完 `bundle.jsonc` 或
  `vsworker/skills/**` 必须重新生成。`.github/workflows/vsworker.yml` 的 `bundle check` 是这道闸门。
- **`resources/opencode-cli` 那个 144 MB 的二进制不在 vsworker 产物里。**
  `packages/desktop/scripts/prebuild.ts:11` 只在 `channel === "dev"` 时下载它，
  `electron-builder.config.ts:75` 的 `files` 又有一条 `"!resources/opencode-cli*"`。
  它是跑过 `bun run dev` 之后留在工作区的东西。VsWorker 的服务端走的是编译进 `out/main/sidecar.js` 的那份。

---

## 1. 前置条件 Prerequisites

- **Bun 1.3.14**，由根 `package.json` 的 `packageManager` 钉死。这是硬门槛：
  `packages/script/src/index.ts:16-18` 在版本不满足 `^1.3.14` 时直接抛错，构建起步就失败。
- **Node**（`npx electron-builder` 要用）。本机是 v24.13.0。
- 仓库根跑过一次 `bun install`。
- 第一次跑 `electron-builder` 会下载 Electron 42.3.3 运行时到 `~/Library/Caches/electron`，
  上百 MB 且**没有进度输出**，不要以为卡死了。
- 平台矩阵：**macOS 机器可以打 mac 和 win 两个平台**（本机已实测，见第 4 节）。反过来
  在 Windows 上打 macOS 不适用（需要 codesign 等 mac 专有工具）。
- `packages/desktop/native/` 这个目录在本仓库里**不存在**，`electron-builder.config.ts:86-90`
  里指向它的那条 `extraResources` 会被静默跳过。**这是正常的**，两个平台的产物都是这样打成功的；
  `bun run native:build` 在这里用不上。

---

## 2. 第一步：把 skill / plugin / MCP 放进 bundle

字段的完整参考在 [README.md](./README.md)，这里只讲打包时要动手做的事。

### 2.1 Skill

Skill vendored 在 `vsworker/skills/` 下，**目录 `<id>/` 或 zip 包 `<id>.zip` 都行**，manifest 里的写法完全一样。

- `SKILL.md` 必需，且 frontmatter 里的 `name` 必须**等于** manifest 里的 `id`，`description` 不能为空。
- 可选 `env.json`（平铺 JSON，运行在该 skill 目录里的 bash 命令会拿到这些环境变量，
  见 README 的 `#### env.json`）。
- 其它文件随意：`scripts/`、`references/` 都会被一起打进去。

硬约束（来自 `vsworker/script/skill-source.ts`）：

- **不许有符号链接** —— 报错原文是 `is a symlink. A bundled skill has to be self-contained.`
- 自动跳过：`__pycache__/`、`.git/`、`.DS_Store`、`Thumbs.db`、`.gitkeep`、`*.pyc`、`*.pyo`、
  `__MACOSX/`、`._*`（macOS 的 AppleDouble 附件）
- 体积告警：单文件 > 256 KiB，或整个 skill > 1 MiB
- 同一个 `<id>` **不能既有目录又有 zip** —— 直接报错，不做优先级猜测

zip 包另外几条（来自 `readArchive`）：

- 里面要么统一裹一层顶层目录（`zip -r <id>.zip <id>/`），要么 `SKILL.md` 直接在包根
  （`cd <id> && zip -r ../<id>.zip .`）。**只有一层且唯一**的顶层目录会被剥掉，其余原样保留。
  顶层目录名不必等于 `<id>`（认身份的是 `SKILL.md` 的 `name`），但不一致会给一条 warning。
- 可执行位取自包里记录的 Unix mode，跟打包机器无关；Windows 打的包没有 mode，里面一律不可执行。
- **zip 包只是构建期的源文件格式**：`bundle generate` 读它、把内容内联进 `skills.gen.ts`，
  产物里没有 zip，用户机器上也不会解压。
- `.gitignore` 管不到 zip 包内部，所以上面那份跳过名单是唯一的防线；`generate` 会为每个包
  打印一条「跳过了哪些文件」的 warning。

两种加法：

```bash
# A. 从你自己的全局 skills 目录 vendor 一份进来（会自动改 bundle.jsonc 并 generate）
#    <dir> 和 <file.zip> 都接受
bun run --cwd vsworker bundle import skill <name> [--from <dir|file.zip>] [--force]

# B. 手工：把 vsworker/skills/<id>/ 目录建好，或者把 <id>.zip 直接丢进 vsworker/skills/，
#    然后往 bundle.jsonc 的 skills 数组加一条
#    { "id": "<id>", "description": "为什么要打包它" }
```

### 2.2 Plugin

`source` 三选一：`local` / `npm` / `github`。

- **`local` 最省事**，也是内部插件的推荐做法：入口固定是 `vsworker/plugins/<id>/index.ts`，
  照抄 `vsworker/plugins/hello/index.ts` 起步。
- `npm` 要钉精确版本（不接受范围），`github` 要 `repo` + 完整 40 位 `ref`。

被打包的插件有五条编写禁令（原生模块、`import.meta.dir`、动态 import、`Bun.*` / `$`、`oc-themes`），
详见 README 的 `## What a bundled plugin may do` —— 因为它是被编译进一个 bundle 的，不是运行时安装的包。

### 2.3 MCP server

manifest 里每条的 `config` 就是 `opencode.json` 里 `mcp.<id>` 的那个值，原样照抄。

- **密钥不要写死**，用 `{env:VAR}` 或 `{file:path}`，两者在配置加载时才替换。
  generator 会扫 `token|secret|key|password|passwd|credential|auth` 并告警。
- `config.enabled` 会被 manifest 校验**直接拒绝**：要控制默认开关请用外层的 `defaultEnabled`。
- 打包的是**定义不是服务端本体**：`type: "local"` 的条目，`command[0]` 必须在每台用户机器上都存在。

```bash
bun run --cwd vsworker bundle import mcp <name> [--from <file>] [--id <id>] [--off]
```

### 2.4 生成并校验

```bash
bun run --cwd vsworker bundle generate       # 重写 src/*.gen.ts、bundle.schema.json、package.json 的 dependencies
bun run --cwd vsworker bundle check          # 应输出 bundle is up to date (…)，括号里是当前条目数
bun run --cwd vsworker bundle check --seams  # 应输出 all 18 seams present
```

`generate` 里那步 `bun install` **只在存在非 local 插件时才会跑**（`vsworker/script/bundle.ts:508`），
所以纯 local + skill 的改动不会动 `bun.lock`。

**提交清单**（少提一个 CI 就会红）：

```
vsworker/bundle.jsonc
vsworker/src/{server,tui,mcp,skills}.gen.ts
vsworker/bundle.schema.json
vsworker/package.json
vsworker/skills/**          # 新增或修改的 skill
bun.lock                    # 只有非 local 插件变动时才会变
```

---

## 3. 第二步：构建 macOS 客户端

```bash
cd packages/desktop
export OPENCODE_CHANNEL=vsworker
export OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
bun run build
npx electron-builder --mac --arm64 --publish never --config electron-builder.config.ts
```

上面这条是在 Apple Silicon 上打 arm64，即**本机构建**。想打 **Intel（darwin-x64）包，那是一次交叉构建**，
跟第 4 节的 Windows 一样要先装对 `node-pty` 并告诉 electron-vite 目标架构，光换 electron-builder 的 flag 不够：

```bash
bun install --cwd packages/desktop --os=darwin --cpu=x64 "@lydell/node-pty-darwin-x64@1.2.0-beta.12"
cd packages/desktop
export OPENCODE_CHANNEL=vsworker OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
OPENCODE_TARGET_PLATFORM=darwin OPENCODE_TARGET_ARCH=x64 bun run build
npx electron-builder --mac --x64 --publish never --config electron-builder.config.ts
```

### `OPENCODE_CHANNEL=vsworker` 到底决定了什么

这是最容易踩错的一处：**四个互相独立的 resolver** 各自读这个变量，管四件不同的事。
因为 `bun run build` 和 `npx electron-builder` 是两条命令，两条都必须看得到它 —— 所以用 `export`。

| 读取处                                           | 决定什么                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `packages/desktop/scripts/utils.ts:12`           | prebuild 用哪套图标 / metainfo，要不要下载 CLI                                 |
| `packages/desktop/electron.vite.config.ts:8`     | 注入 main bundle 的 `import.meta.env.OPENCODE_CHANNEL`                         |
| `packages/desktop/electron-builder.config.ts:32` | appId `com.vsworker.desktop`、productName `VsWorker`、无 publish、mac 签名策略 |
| `packages/app/vite.js:8`                         | 渲染进程；`vsworker` 映射成 `prod`，所以没有 DEV 角标和调试栏                  |

连带结果：`src/main/constants.ts` 的 `UPDATER_ENABLED` 只对 `beta` / `prod` 为真，所以
**vsworker 构建没有自动更新器**，菜单里的 "Check for updates" 是灰的。这是刻意的 ——
上游所有更新源发的都是 opencode，自动更新会把 VsWorker 换成 opencode。

### `OPENCODE_VERSION` 为什么必须显式设

不设的话，`packages/script/src/index.ts:26-36` 会判定这是 preview 构建，版本号变成
`0.0.0-vsworker-<UTC 时间戳>`。这个值会同时进 `extraMetadata.version`（app 的版本）和服务端 bundle，
所以显式设一个有意义的版本，让 app 和里面的服务端报同一个号。

约定：`<上游版本>-vsworker.<UTC 时间戳>`，比如 `1.18.30-vsworker.202609130958`。

### `bun run build` 里面发生了什么

Bun 的 pre-script 约定会先跑 `prebuild`（`packages/desktop/scripts/prebuild.ts`，四步）：

1. `copy-icons.ts vsworker` —— vsworker 通道复用 `icons/prod` 那套美术（`copy-icons.ts:8` 有注释：
   只有名字和 bundle id 不同），拷到 gitignore 的 `resources/icons`。
2. `copy-metainfo.ts vsworker` —— 生成 `resources/com.vsworker.desktop.metainfo.xml`（Linux 用）。
3. **`cd ../opencode && bun script/build-node.ts`** —— 第 0 节那条链路就在这一步落地：
   `packages/opencode/src/node.ts` 连同它静态 import 的 `vsworker/src/*.gen.ts` 一起被打成
   `packages/opencode/dist/node/node.js`。**bundle 是在这里进产物的。**
4. dev 通道才下载 CLI —— vsworker 跳过。

然后 `electron-vite build` 打三份：main（`index.js` + `sidecar.js`）、preload、renderer。

### 产物

都在 `packages/desktop/dist/`：

```
vsworker-desktop-mac-arm64.dmg          # 分发用这个
vsworker-desktop-mac-arm64.dmg.blockmap
vsworker-desktop-mac-arm64.zip
vsworker-desktop-mac-arm64.zip.blockmap
mac-arm64/VsWorker.app                  # 未打包的 .app，本机直接双击即可试
```

命名来自 `artifactName: "vsworker-desktop-${os}-${arch}.${ext}"`。

### 签名与公证

vsworker 通道默认 `identity: process.env.CSC_NAME ?? "-"`，即 **ad-hoc 签名**：
Apple Silicon 不允许完全没有签名的 bundle 启动，ad-hoc 满足加载器但不声明来源。
`notarize` 和 `dmg.sign` 都跟着 `Boolean(process.env.CSC_NAME)` 走，所以默认都不做。

要正式签名 + 公证（前提是有 Developer ID）：

```bash
export CSC_NAME="Developer ID Application: <你的名字> (<TEAMID>)"
export APPLE_API_KEY=/path/to/AuthKey_XXXX.p8
export APPLE_API_KEY_ID=XXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**没有正式签名时的分发提示**：ad-hoc 签名的 app 拷到别人机器上首次打开会被 Gatekeeper 拦，
需要右键 → 打开，或者 `xattr -dr com.apple.quarantine /Applications/VsWorker.app`。
把这句话跟安装包一起发给同事。

---

## 4. 第三步：在 macOS 上交叉构建 Windows 客户端

### 为什么要多两个环境变量

`node-pty` 是**预编译原生模块**，一个平台一个 npm 包，而 main bundle 是**静态** import 它的。
`electron-vite` 看不到 `electron-builder` 的 `--win` 标志（两条独立命令，前者先跑），
所以必须在 `electron.vite.config.ts:15-21` 显式告诉它目标平台是什么：

```ts
const targetPlatform = process.env.OPENCODE_TARGET_PLATFORM || process.platform
const targetArch = process.env.OPENCODE_TARGET_ARCH || process.arch
const nodePtyPkg = `@lydell/node-pty-${targetPlatform}-${targetArch}`
```

**搞错任何一个，app 一启动就去 import 一个不在它里面的模块。** 而且这个包还得真的装上 ——
`bun install` 默认只装匹配当前机器的那个 optional dependency。

### 命令

```bash
bun install --cwd packages/desktop --os=win32 --cpu=x64 "@lydell/node-pty-win32-x64@1.2.0-beta.12"
cd packages/desktop
export OPENCODE_CHANNEL=vsworker
export OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
OPENCODE_TARGET_PLATFORM=win32 OPENCODE_TARGET_ARCH=x64 bun run build
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
```

版本号 `1.2.0-beta.12` 来自根 `package.json` 的 catalog 和 `packages/desktop/package.json` 的
`optionalDependencies`，两处必须一致。

**arm64 Windows**：三处 `x64` 换成 `arm64`，包名换成 `@lydell/node-pty-win32-arm64`，
electron-builder 用 `--win --arm64`。

### 产物与安装形态

```
packages/desktop/dist/vsworker-desktop-win-x64.exe           # NSIS 安装包，分发用这个
packages/desktop/dist/vsworker-desktop-win-x64.exe.blockmap
packages/desktop/dist/win-unpacked/                          # 解包后的目录，可用来检查内容
```

`nsis.oneClick: true` + `perMachine: false` = **一键、按用户安装**，不弹目录选择框，
直接装到 `%LOCALAPPDATA%\Programs\vsworker-desktop`。

这个目录名来自 `extraMetadata.name`（`"vsworker-desktop"`），**不是** productName ——
一键 per-user 安装包按包名而不是产品名建目录，不覆盖的话 workspace 名 `@opencode-ai/desktop`
会变成 `%LOCALAPPDATA%\Programs\@opencode-aidesktop`。

Windows 上的数据目录：`%USERPROFILE%\.config\vsworker` 及其三个兄弟目录
（`xdg-basedir` 没有 Windows 特例），Electron 的 userData 是 `%APPDATA%\com.vsworker.desktop`。
和官方 OpenCode 完全不撞，对照表见 README 的 `## Living next to the official OpenCode`。

### 未签名

`electron-builder.config.ts:22-23` 的 `signWindows()` 在非 Windows 或非 CI 时直接 return，
所以本机交叉出来的 `.exe` **没有 Authenticode 签名**，用户首次运行 SmartScreen 会警告
（点「更多信息」→「仍要运行」）。发给同事时一并说明。

### 收尾两件事

```bash
bun install                 # 回到仓库根，把外来平台的模块清掉
```

- `out/` **只保留最后一次构建的目标平台**。换平台打包前必须重跑 `bun run build`，
  否则 electron-builder 会把上一个平台的 main bundle 装进新壳子。
- 交叉构建会让 `packages/desktop/node_modules/@lydell/` 里同时存在本机和目标平台两份 node-pty
  （打进 Windows 包里的也会同时带上 darwin-arm64 那份，无害但多占空间）。打完跑一次
  `bun install` 复原。

---

## 5. 验证产物确实带上了 bundle

从便宜到彻底，四层：

**① 翻编译后的 main bundle，确认 skill 字符串在里面**

```bash
grep -rl "well-intervention-recommendation" packages/desktop/out/main/
```

应当命中 `packages/desktop/out/main/chunks/node-*.js` —— 那个 chunk 就是被 `virtual:opencode-server`
拉进来的服务端 bundle。**注意要用 `-r` 递归**：内容在 chunk 里，不在 `index.js` / `sidecar.js` 里，
直接 `grep out/main/*.js` 会得到 0，误以为没打进去。换成你自己 skill 的 `id` 同理。

**② 翻打包后的 `app.asar`，确认它进了真正要分发的东西**

```bash
# macOS
grep -ac "well-intervention-recommendation" \
  packages/desktop/dist/mac-arm64/VsWorker.app/Contents/Resources/app.asar
# Windows
grep -ac "well-intervention-recommendation" packages/desktop/dist/win-unpacked/resources/app.asar
```

`-a` 是因为 asar 是二进制容器。命中非 0 即可 —— 这是最强的一条验证，证明内容进了实际分发的产物，
而不只是中间产物。

**③ 查 app 身份**

```bash
plutil -p packages/desktop/dist/mac-arm64/VsWorker.app/Contents/Info.plist \
  | grep -E "CFBundleIdentifier|CFBundleName|CFBundleShortVersionString"
```

应当是 `com.vsworker.desktop` / `VsWorker` / 你设的 `OPENCODE_VERSION`。
如果看到 `ai.opencode.desktop.dev` 或 "VsWorker Dev"，说明 `OPENCODE_CHANNEL` 没传到
electron-builder 那条命令。

**④ 打开 app 实际看一眼**

打开 `VsWorker.app` → Settings（`cmd+,`）→ **Extensions** → Plugins / Skills / MCP servers
三个 tab，bundled 条目应当都列在里面。这是唯一能验证「用户真的能用上」的办法。

> CI 里还有一条 CLI 侧的冒烟（`.github/workflows/vsworker.yml:47-56`）：
> `vsworker skills enable hello -g` 之后检查
> `~/.cache/vsworker/vsworker/skills/hello/SKILL.md` 是否落盘。桌面客户端走的是同一套
> `materialize()`，所以那条也能间接证明解包逻辑没问题。

---

## 6. 排错 Troubleshooting

| 症状                                          | 原因                                                                   | 处理                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bundle check` 报 stale                       | 改了 `bundle.jsonc` 或 `skills/**` 但没重新生成                        | `bun run --cwd vsworker bundle generate`                                            |
| `bundle check --seams` 少 seam                | 上游合并把 `// vsworker-seam` 标记吃掉了                               | 照 [UPSTREAM.md](./UPSTREAM.md) 的 seam 清单补回来                                  |
| app 一启动就崩，报找不到 `@lydell/node-pty-*` | `OPENCODE_TARGET_*` 与 electron-builder 的平台标志不一致，或那个包没装 | 对齐第 4 节的四处平台名，重跑 `bun run build`                                       |
| 打出来叫 "VsWorker Dev"、appId 带 `.dev`      | `OPENCODE_CHANNEL` 没被 electron-builder 那条命令看到                  | 用 `export`，两条命令都要能读到                                                     |
| 版本号是 `0.0.0-vsworker-…`                   | 没设 `OPENCODE_VERSION`                                                | 见第 3 节                                                                           |
| 图标或 metainfo 缺失                          | 跳过 `bun run build` 直接跑 electron-builder                           | `resources/icons` 和 `resources/*.metainfo.xml` 是 gitignore 的生成物，必须先 build |
| 换了平台重打，产物还是旧平台的                | `out/` 没重建                                                          | 换平台前必跑 `bun run build`                                                        |
| `bun run native:build` 失败                   | `packages/desktop/native/` 在本仓库不存在                              | 不用管，这个脚本在这里用不上                                                        |
| 首次 electron-builder 很久没输出              | 在下载 Electron 运行时到 `~/Library/Caches/electron`                   | 等着，没有进度条                                                                    |
| 担心和已装的 `OpenCode.app` 冲突              | 不会                                                                   | appId、数据目录、数据库、安装目录全部分开，见 README 的共存对照表                   |

---

## 7. 速查 Quick reference

改完 bundle 内容：

```bash
bun run --cwd vsworker bundle generate
bun run --cwd vsworker bundle check && bun run --cwd vsworker bundle check --seams
```

macOS（Apple Silicon）全量：

```bash
cd packages/desktop
export OPENCODE_CHANNEL=vsworker OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
bun run build
npx electron-builder --mac --arm64 --publish never --config electron-builder.config.ts
```

Windows x64（在 macOS 上交叉构建）全量：

```bash
bun install --cwd packages/desktop --os=win32 --cpu=x64 "@lydell/node-pty-win32-x64@1.2.0-beta.12"
cd packages/desktop
export OPENCODE_CHANNEL=vsworker OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
OPENCODE_TARGET_PLATFORM=win32 OPENCODE_TARGET_ARCH=x64 bun run build
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
cd ../.. && bun install
```

---

## 附录 A：分发

vsworker 通道**没有 publish 配置、没有更新源**（`electron-builder.config.ts:175` 的注释说明了原因），
所以发布就是手工分发 `.dmg` / `.exe`。

- macOS：给 `.dmg`，附上 Gatekeeper 首次打开的说明（第 3 节末尾）。
- Windows：给 `.exe`，附上 SmartScreen 的说明（第 4 节末尾）。
- 版本号沿用 `<上游版本>-vsworker.<UTC 时间戳>`，让每个包能被唯一指认。
- 用户装了新版本之后不会自动升级 —— 更新器是关的，换版本要重新发包。

配置里也有 Linux 目标（`AppImage` / `deb` / `rpm`，`rpm.packageName` 为 `vsworker`），
但本机没有实测过，不在本文范围内。

## 附录 B：CLI 二进制（不是桌面客户端）

桌面客户端不依赖它，但同一份 bundle 也会编译进 CLI 二进制。命令取自
`.github/workflows/vsworker.yml:43`：

```bash
cd packages/opencode
bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

产物在 `packages/opencode/dist/opencode-<platform>/bin/opencode`（本机是 `opencode-darwin-arm64`）。

> **注意先后顺序**：`script/build.ts` 开头有一句 `rm -rf dist`，会把 `packages/opencode/dist/node/`
> 一起删掉 —— 那正是桌面 prebuild 产出的服务端 bundle。所以打完 CLI 再打桌面客户端的话，
> `bun run build` 会重新生成它，没问题；但**反过来**（先打桌面、再打 CLI、然后直接跑 electron-builder）
> 会失败。桌面产物要重打就重跑 `bun run build`。

冒烟：

```bash
BIN=./dist/opencode-darwin-arm64/bin/opencode
"$BIN" vsworker plugins list
"$BIN" vsworker mcp list
"$BIN" vsworker skills list
```
