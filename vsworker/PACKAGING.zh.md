# 打包 VsWorker 桌面客户端

[English](./PACKAGING.md) | **简体中文**

本文是 **macOS 与 Windows 桌面客户端**的完整打包手册：从把 skill / plugin / MCP 放进 bundle，到打出
`.dmg` / `.exe`，再到验证产物里确实带上了这些内容。

三份文档的分工：

| 文档                           | 管什么                                                  |
| ------------------------------ | ------------------------------------------------------- |
| [README.zh.md](./README.zh.md) | `bundle.jsonc` 的字段语义、用户怎么开关、运行时加载顺序 |
| **PACKAGING.zh.md**（本文）    | 怎么把这些东西打进 macOS / Windows 客户端               |
| [UPSTREAM.md](./UPSTREAM.md)   | 合并上游时怎么不把 fork 的改动弄丢（仅英文）            |

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

## 1. 前置条件

- **Bun 1.3.14 及以上**：`packages/script/src/index.ts:13-18` 用根 `package.json` 的 `packageManager`
  拼出 `^1.3.14` 这个范围去校验，不满足直接抛错，构建起步就失败。注意它是**范围**（`>=1.3.14 <2.0.0`），
  不是精确钉死。
- **Node 22 以上**（`npx electron-builder` 要用；`.github/actions/setup-bun/action.yml:11-16` 说明了
  下限的由来：原生依赖的安装脚本会调 `node-gyp`，它要求 Node ≥ 22）。CI 用 24，本机是 v24.13.0。
- 仓库根跑过一次 `bun install`。**Windows 上要加 `--linker hoisted`**，见第 4.2 节。
- 第一次跑 `electron-builder` 要下两批东西，加起来 165 MB 上下，且**没有进度输出**，不要以为卡死了：
  - Electron 42.3.3 运行时（约 141 MiB）→ macOS `~/Library/Caches/electron`，
    Windows `%LOCALAPPDATA%\electron\Cache`
  - electron-builder 自己的 NSIS / 7-Zip 工具链 → macOS `~/Library/Caches/electron-builder`，
    Windows `%LOCALAPPDATA%\electron-builder\Cache`
- 平台矩阵：

  | 构建机        | mac                       | win x64                 | win arm64                         | linux |
  | ------------- | ------------------------- | ----------------------- | --------------------------------- | ----- |
  | macOS arm64   | arm64 本机 / x64 交叉     | 交叉（第 4.1 节，实测） | 交叉                              | 未测  |
  | Windows x64   | **不行**（要 `codesign`） | **本机**（第 4.2 节）   | 交叉（要 `OPENCODE_TARGET_ARCH`） | 不行  |
  | Windows arm64 | 不行                      | 交叉                    | 本机                              | 不行  |

- `packages/desktop/native/` 这个目录在本仓库里**不存在**，`electron-builder.config.ts:86-90`
  里指向它的那条 `extraResources` 会被静默跳过。**这是正常的**，两个平台的产物都是这样打成功的；
  `bun run native:build` 在这里用不上。

---

## 2. 第一步：把 skill / plugin / MCP 放进 bundle

字段的完整参考在 [README.zh.md](./README.zh.md)，这里只讲打包时要动手做的事。

### 2.1 Skill

Skill 是**目录**，vendored 在 `vsworker/skills/<id>/` 下。

- `SKILL.md` 必需，且 frontmatter 里的 `name` 必须**等于** manifest 里的 `id`，`description` 不能为空。
- 可选 `env.json`（平铺 JSON，运行在该 skill 目录里的 bash 命令会拿到这些环境变量，
  见 README 的 `#### env.json`）。
- 其它文件随意：`scripts/`、`references/` 都会被一起打进去。

硬约束（来自 `vsworker/script/bundle.ts` 的 `resolveSkill` / `walk`）：

- **不许有符号链接** —— 报错原文是 `is a symlink. A bundled skill has to be self-contained.`
- 自动跳过：`__pycache__/`、`.git/`、`.DS_Store`、`Thumbs.db`、`.gitkeep`、`*.pyc`、`*.pyo`
- 体积告警：单文件 > 256 KiB，或整个 skill > 1 MiB

两种加法：

```bash
# A. 从你自己的全局 skills 目录 vendor 一份进来（会自动改 bundle.jsonc 并 generate）
bun run --cwd vsworker bundle import skill <name> [--from <dir>] [--force]

# B. 手工：建好 vsworker/skills/<id>/ 目录，然后往 bundle.jsonc 的 skills 数组加一条
#    { "id": "<id>", "description": "为什么要打包它" }
```

### 2.2 Plugin

`source` 三选一：`local` / `npm` / `github`。

- **`local` 最省事**，也是内部插件的推荐做法：入口固定是 `vsworker/plugins/<id>/index.ts`，
  照抄 `vsworker/plugins/hello/index.ts` 起步。
- `npm` 要钉精确版本（不接受范围），`github` 要 `repo` + 完整 40 位 `ref`。

被打包的插件有五条编写禁令（原生模块、`import.meta.dir`、动态 import、`Bun.*` / `$`、`oc-themes`），
详见 README 的 `## 被打包的插件能做什么` —— 因为它是被编译进一个 bundle 的，不是运行时安装的包。

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
bun run --cwd vsworker bundle check --seams  # 应输出 all 19 seams present
```

`generate` 里那步 `bun install` **只在存在非 local 插件时才会跑**（`vsworker/script/bundle.ts:508`），
所以纯 local + skill 的改动不会动 `bun.lock`。

> **别在 Windows 上跑 `bundle generate`**，原因见第 4.2 节末尾的方框 —— `bundle check` 可以随便跑。

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
跟第 4.1 节的 Windows 一样要先装对 `node-pty` 并告诉 electron-vite 目标架构，光换 electron-builder 的 flag 不够：

```bash
bun install --cwd packages/desktop --os=darwin --cpu=x64 "@lydell/node-pty-darwin-x64@1.2.0-beta.12"
cd packages/desktop
export OPENCODE_CHANNEL=vsworker OPENCODE_VERSION=1.18.30-vsworker.$(date -u +%Y%m%d%H%M)
OPENCODE_TARGET_PLATFORM=darwin OPENCODE_TARGET_ARCH=x64 bun run build
npx electron-builder --mac --x64 --publish never --config electron-builder.config.ts
```

### `OPENCODE_CHANNEL=vsworker` 到底决定了什么

这是最容易踩错的一处：**四个互相独立的 resolver** 各自读这个变量，管四件不同的事。
因为 `bun run build` 和 `npx electron-builder` 是两条命令，两条都必须看得到它 —— 所以用 `export`
（Windows 上对应 `$env:`，见第 4.2 节）。

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

## 4. 第三步：构建 Windows 客户端

两条路：在 macOS 上交叉构建（4.1，本机实测过），或者直接在一台 Windows PC 上原生构建（4.2）。
**原生那条反而更简单** —— 少两个环境变量、少一次跨平台 `bun install`、少一步收尾，
但多几项 macOS 上没有的前置条件。

### 4.1 在 macOS 上交叉构建

#### 为什么要多两个环境变量

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

#### 命令

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

#### 收尾两件事

```bash
bun install                 # 回到仓库根，把外来平台的模块清掉
```

- `out/` **只保留最后一次构建的目标平台**。换平台打包前必须重跑 `bun run build`，
  否则 electron-builder 会把上一个平台的 main bundle 装进新壳子。
- 交叉构建会让 `packages/desktop/node_modules/@lydell/` 里同时存在本机和目标平台两份 node-pty
  （打进 Windows 包里的也会同时带上 darwin-arm64 那份，无害但多占空间）。打完跑一次
  `bun install` 复原。原生构建没有这个问题，出来的 `.exe` 反而更干净。

### 4.2 在 Windows PC 上原生构建

> **本节尚未在一台物理 Windows 机器上完整跑通。** 下面的命令与前置条件是从
> `.github/workflows/publish.yml` 的 Windows matrix、`electron-builder` 的源码和本仓库的配置推导出来的。
> CI 证明了 `bun install` / `bun run build` / `npx electron-builder --win` 这三步在 Windows 上确实可行，
> 但用的是 `prod` 通道 —— `OPENCODE_CHANNEL=vsworker` 的产物、安装包的安装过程、以及本节和第 5 节的
> PowerShell 命令都没有实测。**跑通之后请回来把这段话删掉，并把各处的 `[推导]` 标记改成实测结论。**
>
> 每条结论的来源分三档：`[CI 已证]` = `publish.yml` 的 Windows matrix 真的跑过；
> `[推导]` = 从本仓库的配置/源码直接读出来的，逻辑上确定；`[未验证]` = 合理推测，没人跑过。

#### 命令（PowerShell 7）

```powershell
# 仓库根，一次就够（--linker hoisted 的理由见下面的前置条件）
bun install --linker hoisted

cd packages\desktop
$env:OPENCODE_CHANNEL = "vsworker"
$env:OPENCODE_VERSION = "1.18.30-vsworker.$([DateTime]::UtcNow.ToString('yyyyMMddHHmm'))"
bun run build
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
```

跟 4.1 相比，**少掉的三样东西才是重点**：

- **不需要 `OPENCODE_TARGET_PLATFORM` / `OPENCODE_TARGET_ARCH`。** `electron.vite.config.ts:19-21`
  在这两个变量缺省时回落到 `process.platform` / `process.arch`，在 x64 Windows 上它们本来就是
  `win32` / `x64`，算出来的正是 `@lydell/node-pty-win32-x64`。4.1 那套理由在这里整个不成立。
  `[推导]` + `[CI 已证]`：`publish.yml:320-333` 的 Build 步骤在两个 Windows matrix 行上都没设这两个变量。
- **不需要 `bun install --cwd packages/desktop --os=win32 --cpu=x64 …`。** `publish.yml:235-250`
  只给两个 macOS 行配了 `bun_install_flags`，Windows 行是空的 —— 本机的 `bun install` 本来就会装上
  匹配的 optional dependency。`[CI 已证]`
- **不需要收尾的 `bun install`。** 从来没装过外来平台的模块，产物里也只有 `win32-x64` 那一份。`[推导]`

两个写法上的注意：

- `$env:VAR = "…"` 就是 `export` 的等价物 —— 它设在当前 PowerShell 进程上，`bun run build` 和
  `npx electron-builder` 这两个子进程都继承得到。第 3 节说的「两条命令都必须看得到 `OPENCODE_CHANNEL`」
  在这里同样成立。
- `$([DateTime]::UtcNow.ToString('yyyyMMddHHmm'))` 是 `$(date -u +%Y%m%d%H%M)` 的精确等价物。
  **不要**用 `Get-Date -UFormat`（PS 7 里已废弃），也**不要**用不带 `.ToUniversalTime()` 的
  `Get-Date -Format`（那是本地时间）。

#### arm64 Windows

在一台 **arm64 Windows** 上打 arm64，跟上面完全一样，只是 electron-builder 换成 `--win --arm64`
（`process.arch` 已经是 `arm64`）。`[未验证]`

在 **x64 Windows 上打 arm64**，那就是一次交叉构建，4.1 的整套又回来了：

```powershell
bun install --linker hoisted --cwd packages\desktop --os=win32 --cpu=arm64 "@lydell/node-pty-win32-arm64@1.2.0-beta.12"
cd packages\desktop
$env:OPENCODE_CHANNEL = "vsworker"
$env:OPENCODE_VERSION = "1.18.30-vsworker.$([DateTime]::UtcNow.ToString('yyyyMMddHHmm'))"
$env:OPENCODE_TARGET_ARCH = "arm64"     # 必须设：process.arch 是 x64
bun run build
npx electron-builder --win --arm64 --publish never --config electron-builder.config.ts
cd ..\..
bun install --linker hoisted            # 复原：把外来架构的 node-pty 清掉
```

> **`$env:` 在整个 PowerShell 会话里是持久的。** 打完 arm64 再打 x64 之前，
> 要么开一个新的 `pwsh` 窗口，要么 `Remove-Item Env:\OPENCODE_TARGET_ARCH`，
> 否则下一次 `bun run build` 会悄悄还按 arm64 打。`out/` 只保留最后一次的目标平台，换平台前必跑
> `bun run build` —— 这条在 Windows 上比在 macOS 上更容易踩，因为在两个架构之间来回切是常事。

#### Windows 特有的前置条件

第 1 节那几条仍然成立，下面是**只有 Windows 才有**的：

**`bun install` 要加 `--linker hoisted`。** `.github/actions/setup-bun/action.yml:56-66` 只在 Windows 上
这么做，注释指向 bun#28147 和 `patches/` 里打过补丁的 peer 依赖（本仓库有 19 条 `patchedDependencies`）。
`[CI 已证]`。两个文档里不明显的点：

- **这个 flag 不粘。** 之后任何一次不带参数的 `bun install` 都会退回默认的 isolated linker，
  所以**每次**都要带上，包括 4.2 arm64 变体里 `--cwd packages\desktop` 那次。`[推导]`
- **`bundle generate` 会把它冲掉。** `vsworker/script/bundle.ts:490-494` spawn 的是一条光秃秃的
  `bun install`。目前 `bundle.jsonc` 里没有非 `local` 插件，这条路走不到（`bundle.ts:507`），
  但以后加了就会踩。`[推导]`

**要装 Visual Studio 2022 Build Tools（Desktop development with C++）和 Python 3。**
「反正都是预编译的」这个直觉在这里不成立，有一个包例外：`tree-sitter-powershell@0.25.10`
（`packages/opencode/package.json:145` 的直接依赖）的 `"install": "node-gyp-build"`，但它发布的 tarball
里**没有** `prebuilds/` 目录，于是回退到 `node-gyp rebuild` 从源码编译；而它又在根 `package.json` 的
`trustedDependencies` 里，bun 一定会跑它的安装脚本。`[推导]`
`windows-2025` runner 预装了 MSVC 和 Python，所以 CI 里看不到安装步骤 —— **别把这理解成不需要**。
Python 3.12+ 还要 `python -m pip install setuptools`（`distutils` 被移除了，CI 在
`setup-bun/action.yml:52-54` 做的就是这件事）。`[CI 已证]`

其余原生依赖都是下载或纯 JS：`esbuild` 的 postinstall 是下二进制，`electron@42.3.3` 压根没有 `scripts`，
`@parcel/watcher` 的 `install` 脚本不在 `trustedDependencies` 里所以不会跑（各平台的预编译包覆盖了它）。
根 `postinstall` 调的 `packages/core/script/fix-node-pty.ts:11` 整个函数体包在
`if (process.platform !== "win32")` 里，在 Windows 上是空转。`[推导]`

**clone 之前先 `git config --global core.autocrlf false`。** 这是最阴的一条。
仓库里没有任何 `* text=auto`（根 `.gitattributes` 只有两行 `linguist-generated`），
而 Git for Windows 安装器默认 `core.autocrlf=true`。后果：

1. 刚 clone 完 `bundle check` 就报四个 `*.gen.ts` 全部 stale —— `bundle.ts:497-500` 是把 prettier 的
   输出（默认 LF）和磁盘上的字节逐字比较。`[推导]`
2. 更糟的是接着用 `bundle generate` 去「修」它：`resolveSkill` 按原始字节读 `SKILL.md` 和各个脚本
   （`bundle.ts:297-301`），再经 `JSON.stringify` 写进 `data:` 字段（`bundle.ts:346-348`），
   于是每个 CRLF 变成字面量 `\r\n` 永久留在 `skills.gen.ts` 里。这份脏数据**会发到用户手上** ——
   `materialize()` 是原样把 `data` 写回磁盘的。`[推导]`

**clone 之前开 Developer Mode，并 `git config --global core.symlinks true`。**
仓库里有 60 个入库的符号链接，其中 55 个是 `packages/*/public/*`（favicon、社交分享图、`site.webmanifest`），
而 `packages/app/public` 正是渲染进程的 `publicDir`（`electron.vite.config.ts:101`）。
链接没展开的话它们会变成一行文本文件，**构建照样成功，只是打出来的 app 图标和 manifest 是坏的**。
`core.symlinks` 是在 clone 时采样的，clone 完再改要重新检出。`[推导]`

**长路径。** isolated linker 下最深的相对路径 200 字符，换成 `--linker hoisted` 降到约 148；
仓库自己最深的源码路径是 127。再叠上 clone 根目录和 electron-builder 的 NSIS 暂存目录，离 260 的
MAX_PATH 不算很远。便宜的保险：

```powershell
git config --system core.longpaths true
# 需要管理员权限，每台机器一次：
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1
```

并且尽量 clone 到 `C:\dev\` 这类短路径下。`[推导]`（是否真的会撞上：`[未验证]`）

**Defender 排除项。** `node_modules` 有 3.1 GB / 约 2400 个包，Electron 的 zip 141 MiB，
NSIS 打包时还要把整棵树再读一遍 —— 实时扫描会逐个文件插一脚。建议（管理员权限）给仓库目录、
`%LOCALAPPDATA%\electron`、`%LOCALAPPDATA%\electron-builder`、`%LOCALAPPDATA%\Temp` 加
`Add-MpPreference -ExclusionPath`，再加 `-ExclusionProcess bun.exe, node.exe`。
不加的话，`bun install` 和第一次 `electron-builder` 会比 macOS 慢好几倍。`[未验证]`

**PowerShell 7 不是构建的必需品**，5.1 也能跑：非 CI 情况下没有任何一步会去 spawn `pwsh`
（`electron-builder.config.ts:21-30` 和 `scripts/utils.ts:88-90` 那两处都被 CI 闸门挡着）。
但还是建议装 7，因为第 5 节的校验脚本用了 `[System.Text.Encoding]::Latin1`（.NET 5+）；
5.1 上的等价写法是 `[System.Text.Encoding]::GetEncoding(28591)`。`[推导]`

#### 产物与安装形态

跟 4.1 完全一样，因为 `electron-builder.config.ts` 的 `win` / `nsis` 两段来自 `getBase()`，
跟构建机无关：

```
packages\desktop\dist\vsworker-desktop-win-x64.exe           # NSIS 安装包，分发用这个
packages\desktop\dist\vsworker-desktop-win-x64.exe.blockmap
packages\desktop\dist\win-unpacked\                          # 解包后的目录，可用来检查内容
```

`nsis.oneClick: true` + `perMachine: false` = **一键、按用户安装**，不弹目录选择框，
直接装到 `%LOCALAPPDATA%\Programs\vsworker-desktop`。

这个目录名来自 `extraMetadata.name`（`"vsworker-desktop"`），**不是** productName ——
一键 per-user 安装包按包名而不是产品名建目录，不覆盖的话 workspace 名 `@opencode-ai/desktop`
会变成 `%LOCALAPPDATA%\Programs\@opencode-aidesktop`。

Windows 上的数据目录：`%USERPROFILE%\.config\vsworker` 及其三个兄弟目录
（`xdg-basedir` 没有 Windows 特例），Electron 的 userData 是 `%APPDATA%\com.vsworker.desktop`。
和官方 OpenCode 完全不撞，对照表见 README 的 `## 与官方 OpenCode 共存`。

#### 未签名（在 Windows 上原因不一样）

4.1 里 `signWindows()`（`electron-builder.config.ts:21-30`）是被**第一道**闸门
`process.platform !== "win32"` 挡下的。在 Windows 上这道闸门**放行**，真正挡住的是第二道：
`if (process.env.GITHUB_ACTIONS !== "true") return`（`:23`）。结果一样 —— 本机打出来的 `.exe`
**没有 Authenticode 签名**，用户首次运行 SmartScreen 会警告（点「更多信息」→「仍要运行」）。
发给同事时一并说明。`[推导]`

**那我把 `GITHUB_ACTIONS=true` 设上不就行了？** 不行，而且可能把构建搞挂。两种结局：

- **没装 pwsh 7**：`electron-builder.config.ts:25-29` 去 spawn `pwsh`，直接 `ENOENT`。这个 reject
  没人吞 —— `app-builder-lib` 的 `winPackager.js:197` 是 `await this.signIf(file)`，
  重试三次之后抛出，**electron-builder 硬失败**。
- **装了 pwsh 7**：`script/sign-windows.ps1` 跑起来，它自己第 12 行的 CI 检查放行，然后在 23-26 行
  发现 Azure Trusted Signing 的三个变量（`AZURE_TRUSTED_SIGNING_ENDPOINT` / `_ACCOUNT_NAME` /
  `_CERTIFICATE_PROFILE`）都没设，打印一行 `Skipping Windows signing…` 就 `exit 0`。
  electron-builder 却会把这个文件记成「已签名」，其实什么都没发生。

结论：**设 `GITHUB_ACTIONS=true` 永远签不出签名，还可能让构建失败。别设。** `[推导]`

顺带一个反直觉的点：这个 hook 在**所有平台**上都会被调用。`windowsSignToolManager.js:132-159` 里，
没有证书时 `cscInfo` 为空，但因为 `signtoolOptions.sign` 这个自定义函数存在，它不会走
「skip signing」那条分支，而是去调我们的函数 —— 我们的函数立刻 return。这也是为什么
electron-builder 从来不去下载 `winCodeSign-*` 那个工具链。`[推导]`

#### 别在 Windows 上跑 `bundle generate`

> `vsworker/script/bundle.ts:309` 把 `executable` 写死成
> `process.platform !== "win32" && (stat.mode & 0o111) !== 0` —— **在 win32 上恒为 `false`**。
> NTFS 本来就没有执行位，`core.filemode` 在 Windows 上默认也是 `false`，这行只是让它变得确定。
> 后果：`vsworker/src/skills.gen.ts` 里所有 `executable: true` 的条目会被改写成 `false`，
> 连带 `export const hash` 也变（`bundle.ts:332-344` 的注释写明了 `executable` 参与哈希，
> 「改个 chmod 也要让缓存失效」）。CI 跑在 `ubuntu-latest` 上（`.github/workflows/vsworker.yml:15`），
> 执行位是好的，于是 `bundle check` 逐字比较后失败：`Generated output is stale`。
>
> **老实说清楚影响范围**：目前**用户侧看不到任何问题** —— 现有 skill 的说明里都是
> `python3 scripts/xxx.py` 这种调法，不需要执行位。所以这是一个**红 CI / 仓库卫生**问题，
> 不是功能问题 —— 除非以后有人加的 skill 直接写 `./scripts/foo.py`，那时 Windows 上生成的 bundle
> 会把一个没有执行位的脚本发出去，在 macOS / Linux 上运行时报 `permission denied`。
>
> 所以 Windows 上的协作者应该：
>
> - `bun run --cwd vsworker bundle check` 随便跑 —— 它只读，且平台无关（前提是 `core.autocrlf` 是 `false`）。
> - `vsworker/bundle.jsonc` 和 `vsworker/skills/**` 随便改。
> - 把 `bundle generate` 放到 macOS / Linux / WSL2 上跑，从那边提交。
>   （WSL2 里的检出放在 Linux 文件系统上是最干净的答案：那是真正的 POSIX 文件系统，执行位和 LF 都正常。）
> - 万一误提交了 Windows 上生成的 `skills.gen.ts`：`git checkout -- vsworker/src/skills.gen.ts`；
>   或者在任意一台 POSIX 机器上 `chmod +x` 回来再重新 `generate`。
>
> **本节的打包命令不受影响** —— `bun run build` 只消费已经生成好的 `*.gen.ts`。
>
> 根治的办法是让 generator 去读 git 索引里的 mode（`git ls-files -s`）而不是 `fs.stat`，
> 这样它就跟构建机无关了。目前还没这么做。

---

## 5. 验证产物确实带上了 bundle

从便宜到彻底，四层。macOS 用 bash，Windows 用 PowerShell。

**① 翻编译后的 main bundle，确认 skill 字符串在里面**

```bash
# macOS / Linux
grep -rl "well-intervention-recommendation" packages/desktop/out/main/
```

```powershell
# Windows
Get-ChildItem -Path packages\desktop\out\main -Recurse -File -Filter *.js |
  Select-String -Pattern "well-intervention-recommendation" -List |
  Select-Object -ExpandProperty Path
```

应当命中 `packages/desktop/out/main/chunks/node-*.js` —— 那个 chunk 就是被 `virtual:opencode-server`
拉进来的服务端 bundle。**注意要递归**：内容在 chunk 里，不在 `index.js` / `sidecar.js` 里，
直接 `grep out/main/*.js` 会得到 0，误以为没打进去。换成你自己 skill 的 `id` 同理。

PowerShell 那条里 **`-Filter *.js` 不是可选的**：`out/main/chunks/` 下还有几 MB 的
`photon_rs_bg-*.wasm` / `tree-sitter-*.wasm`，不过滤的话 `Select-String` 会在二进制上产生噪音。

**② 翻打包后的 `app.asar`，确认它进了真正要分发的东西**

```bash
# macOS
grep -ac "well-intervention-recommendation" \
  packages/desktop/dist/mac-arm64/VsWorker.app/Contents/Resources/app.asar
# 交叉构建出来的 Windows 产物，在 macOS 上也能这么查
grep -ac "well-intervention-recommendation" packages/desktop/dist/win-unpacked/resources/app.asar
```

`-a` 是因为 asar 是二进制容器。命中非 0 即可 —— 这是最强的一条验证，证明内容进了实际分发的产物，
而不只是中间产物。

Windows 上**推荐按字节扫**，自给自足、不依赖外部工具：

```powershell
$asar   = "packages\desktop\dist\win-unpacked\resources\app.asar"
$needle = "well-intervention-recommendation"
$bytes  = [System.IO.File]::ReadAllBytes((Resolve-Path $asar))
$text   = [System.Text.Encoding]::Latin1.GetString($bytes)   # PS 5.1: [System.Text.Encoding]::GetEncoding(28591)
$n = 0; $i = 0
while (($i = $text.IndexOf($needle, $i)) -ge 0) { $n++; $i += $needle.Length }
"$n hit(s)"
```

之所以指定 Latin1：它是严格的字节↔字符一一映射，archive 里任何字节序列都不会被吞掉、合并，
或者变成 U+FFFD —— 而 UTF-8 / ANSI 解码都可能。要查的字符串是纯 ASCII，经这层映射原样不变。

想快速要个是/否，可以用 `findstr /M /C:"well-intervention-recommendation" <path>`（它原生支持二进制输入，
`/M` 相当于 `grep -l`），但它没有计数，且在超长行上不太可靠，当冒烟用就好。

> **不要**直接 `Select-String -Path …app.asar`。它会把一个几百 MB、满是 NUL 的 blob 按行切开，
> 单「行」可能几十 MB，而且 PS 5.1（ANSI）和 PS 7（UTF-8）的编码启发式不一样。它可能能用，
> 也可能悄悄漏掉 —— 失败模式是**假阴性**，对一个校验步骤来说这是最坏的结果。
>
> **也不要去搜 `dist\vsworker-desktop-win-x64.exe`。** NSIS 安装包整个是 LZMA 压缩的，
> 实测在里面搜永远是 0。只有 `win-unpacked\resources\app.asar` 是可搜的。

**③ 查 app 身份**

macOS 上一个 `Info.plist` 就全齐了：

```bash
plutil -p packages/desktop/dist/mac-arm64/VsWorker.app/Contents/Info.plist \
  | grep -E "CFBundleIdentifier|CFBundleName|CFBundleShortVersionString"
```

应当是 `com.vsworker.desktop` / `VsWorker` / 你设的 `OPENCODE_VERSION`。
如果看到 `ai.opencode.desktop.dev` 或 "VsWorker Dev"，说明 `OPENCODE_CHANNEL` 没传到
electron-builder 那条命令。

**Windows 上没有 `plutil`，也没有任何单个文件同时带这三项**，要分几处看（按推荐顺序）：

```powershell
# (a) exe 的 VersionInfo —— 最接近 Info.plist 的一处，能同时证明 CHANNEL 和 VERSION 都生效了
(Get-Item packages\desktop\dist\win-unpacked\VsWorker.exe).VersionInfo |
  Format-List ProductName, FileDescription, CompanyName, FileVersion, ProductVersion, LegalCopyright
```

| 字段              | 期望值                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `ProductName`     | `VsWorker`（打成 dev 通道会是 `VsWorker Dev`）                    |
| `FileDescription` | `VsWorker`                                                        |
| `FileVersion`     | **完整的 `OPENCODE_VERSION`**，如 `1.18.30-vsworker.202609151830` |
| `ProductVersion`  | `1.18.30.0` —— 预发布号被剥掉了，**不要**拿这个字段去核对版本     |

```powershell
# (b) 最便宜的一条：看文件名。通道错了会变成 win-unpacked\VsWorker Dev.exe
Get-ChildItem packages\desktop\dist\win-unpacked\*.exe

# (c) 唯一逐字出现 appId 的地方
Select-String -Path packages\desktop\dist\builder-effective-config.yaml -Pattern "appId|productName"
```

(c) 应当是 `appId: com.vsworker.desktop` / `productName: VsWorker`。**注意**这个文件只在
`!isCI && process.stdout.isTTY` 时才会写（`app-builder-lib` 的 `packager.js:298-302`），
也就是说要在交互式 pwsh 里跑、别把输出管道出去，否则它根本不存在。

> **不要**去 asar 里 grep `com.vsworker.desktop` 来判断通道。`packages/desktop/src/main/index.ts:60-66`
> 的 `APP_IDS` 把**四个通道的 appId 全都**编进了每一个构建，`:128` 还硬写了一个
> `"ai.opencode.desktop.dev"` 字面量。搜到了什么也说明不了。

**④ 打开 app 实际看一眼**

打开 `VsWorker.app` / `VsWorker.exe` → Settings（macOS `cmd+,`，Windows `Ctrl+,`）→ **Extensions**
→ Plugins / Skills / MCP servers 三个 tab，bundled 条目应当都列在里面。
这是唯一能验证「用户真的能用上」的办法。

> CI 里还有一条 CLI 侧的冒烟（`.github/workflows/vsworker.yml:47-56`，跑在 `ubuntu-latest` 上）：
> `vsworker skills enable hello -g` 之后检查
> `~/.cache/vsworker/vsworker/skills/hello/SKILL.md` 是否落盘。桌面客户端走的是同一套
> `materialize()`，所以那条能间接证明解包逻辑没问题 —— 但它不是 Windows 上的证据。

---

## 6. 排错

### 通用

| 症状                                          | 原因                                                                   | 处理                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bundle check` 报 stale                       | 改了 `bundle.jsonc` 或 `skills/**` 但没重新生成                        | `bun run --cwd vsworker bundle generate`（别在 Windows 上跑，见 4.2）               |
| `bundle check --seams` 少 seam                | 上游合并把 `// vsworker-seam` 标记吃掉了                               | 照 [UPSTREAM.md](./UPSTREAM.md) 的 seam 清单补回来                                  |
| app 一启动就崩，报找不到 `@lydell/node-pty-*` | `OPENCODE_TARGET_*` 与 electron-builder 的平台标志不一致，或那个包没装 | 对齐第 4 节的四处平台名，重跑 `bun run build`                                       |
| 打出来叫 "VsWorker Dev"、appId 带 `.dev`      | `OPENCODE_CHANNEL` 没被 electron-builder 那条命令看到                  | 用 `export` / `$env:`，两条命令都要能读到                                           |
| 版本号是 `0.0.0-vsworker-…`                   | 没设 `OPENCODE_VERSION`                                                | 见第 3 节                                                                           |
| 图标或 metainfo 缺失                          | 跳过 `bun run build` 直接跑 electron-builder                           | `resources/icons` 和 `resources/*.metainfo.xml` 是 gitignore 的生成物，必须先 build |
| 换了平台重打，产物还是旧平台的                | `out/` 没重建                                                          | 换平台前必跑 `bun run build`                                                        |
| `bun run native:build` 失败                   | `packages/desktop/native/` 在本仓库不存在                              | 不用管，这个脚本在这里用不上                                                        |
| 首次 electron-builder 很久没输出              | 在下 Electron 运行时和 NSIS 工具链，约 165 MB，没有进度条              | 等着。缓存位置见第 1 节                                                             |
| 担心和已装的 `OpenCode.app` 冲突              | 不会                                                                   | appId、数据目录、数据库、安装目录全部分开，见 README 的共存对照表                   |

### Windows 专有

| 症状                                                              | 原因                                                                                                                            | 处理                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `bun install` 挂在 `tree-sitter-powershell`，日志里有 `gyp ERR!`  | 该包不发 `prebuilds/`，`node-gyp-build` 回退到源码编译；它在 `trustedDependencies` 里，bun 一定会跑                             | 装 VS 2022 Build Tools（Desktop development with C++）+ Python 3，重跑 `bun install --linker hoisted` |
| `node-gyp` 报 `No module named 'distutils'`                       | Python 3.12+ 移除了 distutils                                                                                                   | `python -m pip install setuptools`                                                                    |
| 刚 clone 完 `bundle check` 就报四个 `*.gen.ts` 全 stale           | `core.autocrlf=true`，工作区是 CRLF；`bundle.ts:497-500` 是逐字节比较，prettier 输出是 LF                                       | `git config --global core.autocrlf false` 后重新 clone。**别用 `bundle generate` 去「修」**           |
| 只有 `skills.gen.ts` stale，且发生在你跑过 `bundle generate` 之后 | `bundle.ts:309` 在 win32 上把执行位写成 `false`                                                                                 | `git checkout -- vsworker/src/skills.gen.ts`；见 4.2 末尾的方框                                       |
| app 图标 / `site.webmanifest` 是一行文本路径                      | clone 时 `core.symlinks=false`，55 个 `packages/*/public/*` 软链接变成了文本文件                                                | 开 Developer Mode，`git config --global core.symlinks true`，重新 clone                               |
| 深层 `node_modules` 下报路径过长 / `ENOENT`                       | isolated linker 下最深 200 字符，加上 clone 根目录可能越过 MAX_PATH 260                                                         | `core.longpaths` + 注册表 `LongPathsEnabled=1`；clone 到 `C:\dev\`；用 `--linker hoisted`             |
| `electron-builder` 报 `spawn pwsh ENOENT` 然后失败                | 你设了 `GITHUB_ACTIONS=true`，`electron-builder.config.ts:23` 放行，`:26` 去 spawn `pwsh`；`winPackager.js:197` 不吞这个 reject | 别设 `GITHUB_ACTIONS`。设了也签不出来，见 4.2「未签名」                                               |
| 打 arm64 但 app 启动报找不到 `@lydell/node-pty-win32-arm64`       | 在 x64 机器上打 arm64 却没设 `OPENCODE_TARGET_ARCH=arm64`                                                                       | 见 4.2 的 arm64 变体，三处架构名必须一致                                                              |
| 打完一个架构再打另一个，产物还是上一次的                          | `$env:OPENCODE_TARGET_ARCH` 在当前会话里持久，且 `out/` 只留最后一次                                                            | `Remove-Item Env:\OPENCODE_TARGET_ARCH` 或开新窗口，换平台前必跑 `bun run build`                      |
| `bun install` 和第一次 `electron-builder` 慢得离谱                | node_modules 3.1 GB / 约 2400 个包，Defender 逐文件扫                                                                           | 给仓库和三个缓存目录加 Defender 排除项，见 4.2                                                        |
| `dist\builder-effective-config.yaml` 不存在                       | `packager.js:298` 只在非 CI 且 stdout 是 TTY 时写                                                                               | 在交互式 pwsh 里跑，别把输出管道出去                                                                  |
| 在 `app.asar` 上搜不到，但产物其实是对的                          | `Select-String` 对二进制 + 超长行不可靠；NSIS 的 `.exe` 是 LZMA 压缩的                                                          | 用第 5 节 ② 的字节扫描，且只搜 `win-unpacked\resources\app.asar`                                      |

---

## 7. 速查

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

Windows x64（在 Windows PC 上原生构建）全量：

```powershell
bun install --linker hoisted
cd packages\desktop
$env:OPENCODE_CHANNEL = "vsworker"
$env:OPENCODE_VERSION = "1.18.30-vsworker.$([DateTime]::UtcNow.ToString('yyyyMMddHHmm'))"
bun run build
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
```

---

## 附录 A：分发

vsworker 通道**没有 publish 配置、没有更新源**（`electron-builder.config.ts:175` 的注释说明了原因），
所以发布就是手工分发 `.dmg` / `.exe`。

- macOS：给 `.dmg`，附上 Gatekeeper 首次打开的说明（第 3 节末尾）。
- Windows：给 `.exe`，附上 SmartScreen 的说明（第 4.2 节「未签名」）。
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

产物在 `packages/opencode/dist/opencode-<platform>/bin/opencode`。本机是 `opencode-darwin-arm64`；
**Windows 上是 `dist\opencode-windows-x64\bin\opencode.exe`** —— `script/build.ts:149` 特意把
`win32` 改名成 `windows`（注释说 `win32` 会让 npm 犯迷糊），`windowsify()` 再补上 `.exe`。

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

```powershell
$BIN = ".\dist\opencode-windows-x64\bin\opencode.exe"
& $BIN vsworker plugins list
& $BIN vsworker mcp list
& $BIN vsworker skills list
```
