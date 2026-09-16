# 内置的 plugin、MCP server 与 skill

[English](./README.md) | **简体中文**

VsWorker 在产品内部自带一套精选的 plugin、MCP server 定义和 skill。它们在构建时就被编译进 CLI 二进制
和桌面端的服务端 bundle，所以终端用户不需要 npm、不需要 GitHub、也不需要任何网络访问就能用上。
反过来说，要更新其中任何一项，就意味着发一个新的 VsWorker 版本。

本目录下的一切都归 fork 所有。上游 OpenCode 的文件一共只被动了**二十一处**，其中十九处标了
`// vsworker-seam`，全部登记在 [UPSTREAM.md](./UPSTREAM.md) 里。

本文是**字段参考**：manifest 接受哪些字段，用户怎么关掉某一项。构建 macOS 和 Windows 桌面客户端看
[PACKAGING.zh.md](./PACKAGING.zh.md)；合并上游看 [UPSTREAM.md](./UPSTREAM.md)（仅英文）。

## manifest

`bundle.jsonc` 是唯一决定「什么东西会被打包」的地方。改完之后跑：

```bash
bun run --cwd vsworker bundle generate
```

它会重写本包的 `dependencies`、跑一次 `bun install`，并重新生成 `src/server.gen.ts`、`src/tui.gen.ts`、
`src/mcp.gen.ts`、`src/skills.gen.ts` 和 `bundle.schema.json`。这些文件要跟 `bun.lock` 一起提交。

有三个字段在三个小节里含义相同：

| 字段             | 含义                                                          |
| ---------------- | ------------------------------------------------------------- |
| `id`             | 稳定标识。用户在配置里用它，CLI 也打印它。小写。              |
| `enabled`        | `false` 表示这一条整个不进构建。默认 `true`。                 |
| `defaultEnabled` | `false` 表示打包进去但默认不开，等用户自己打开。默认 `true`。 |
| `description`    | 为什么要打包这一条。写给人看的。                              |

### `plugins`

| 字段      | 适用于      | 含义                                                           |
| --------- | ----------- | -------------------------------------------------------------- |
| `source`  | 全部        | `npm`、`github` 或 `local`。                                   |
| `package` | npm, github | 包名。必须和该包自己 `package.json` 里的 `name` 一致。         |
| `version` | npm         | 精确版本。范围会被拒绝 —— 范围会让两次构建结果不同。           |
| `repo`    | github      | `owner/repo`。                                                 |
| `ref`     | github      | 完整的 40 位 commit sha。分支名同理会被拒绝。                  |
| `path`    | local       | 相对 `vsworker/` 的入口。默认 `plugins/<id>/index.ts`。        |
| `kind`    | 全部        | `server` 或 `tui`。从包的 exports 自动判断，只在需要覆盖时写。 |
| `options` | 全部        | 作为第二个参数传给插件。用户可以逐个键覆盖。                   |

```jsonc
// 一个 npm 包，钉死版本
{ "id": "wakatime", "source": "npm", "package": "opencode-wakatime", "version": "1.2.3" }

// 一个 GitHub 仓库，钉到某个 commit。仓库根必须本身就是一个可安装的 npm 包。
{ "id": "team-tools", "source": "github", "package": "team-tools", "repo": "acme/team-tools",
  "ref": "0123456789abcdef0123456789abcdef01234567" }

// 一个放在 vsworker/plugins/ 下的内部插件
{ "id": "intranet", "source": "local", "options": { "url": "http://10.0.0.5" } }
```

如果一个 GitHub 仓库的插件在子目录里，那它没法直接用 —— Bun 的 git 依赖是按整个仓库寻址的。
把那个插件 vendor 进 `vsworker/plugins/`，改成 `local` 条目。

### `mcp`

`config` 就是 `opencode.json` 里 `mcp.<id>` 的那个值，用平铺的 V1 形状。`id` 是用户看到的服务器名字，
也是它那些工具名的前缀。

```jsonc
{ "id": "intranet-docs", "config": { "type": "remote", "url": "http://10.0.0.5/mcp",
  "headers": { "Authorization": "Bearer {env:INTRANET_TOKEN}" } } }

{ "id": "sqlite", "config": { "type": "local", "command": ["uvx", "mcp-server-sqlite", "--db", "./app.db"] },
  "defaultEnabled": false }
```

`config.enabled` 会被拒绝：请用 `defaultEnabled`，因为 `enabled` 正是用户用来覆盖它的那个键。

有两件事是一条内置定义替你做不到的：

- **密钥。** 这条定义会被编译进每一份构建，所以写在 `headers`、`oauth.clientSecret` 或 `environment`
  里的明文 token 会发给所有人。请改用 `{env:VAR}` 或 `{file:path}`，两者都在配置加载时才替换，
  `{file:}` 的相对路径按用户的全局配置目录解析。`bundle generate` 会对它能识别出的明文告警。
- **安装服务端本身。** `local` 类型的服务器，`command[0]` 必须已经存在于每一台用户机器上。
  远程服务器没有这个要求，所以它们更适合打包。

### `skills`

Skill 在本仓库里 vendored 在 `vsworker/skills/` 下，**目录 `<id>/` 或 zip 包 `<id>.zip` 都行**：
一个 `SKILL.md` 加上它需要的 `scripts/` / `references/` 文件。每个文件都会被内联进构建，并在
「带着已启用 skill 的构建」第一次启动时写到 `~/.cache/vsworker/vsworker/skills/<id>/`。
运行时它们需要磁盘上的真实目录，因为 `skill` 工具要列出同级文件，斜杠命令也要解析相对路径。

```jsonc
{ "id": "report-review", "description": "审核流程 the team follows for 可研报告" }
{ "id": "drilling-intervention-recommendation", "description": "钻井事故与复杂情况处置措施推荐" } // skills/<id>.zip
{ "id": "hello", "path": "skills/hello", "defaultEnabled": false }
```

两种形态的 manifest 写法完全一样，所以从识油平台拿到的 zip 包可以原样丢进去。`path` 也两种都能指。
同一个 `<id>` **既有目录又有 zip 是错误**，不是优先级规则：skills 哈希把着 `bundle check`，
要是靠优先级悄悄挑一个，那么少了其中一种的机器就会算出不同的哈希，而屏幕上没有任何线索。

frontmatter 里的 `name` 必须等于 `id`，`description` 必填 —— 模型正是靠它来挑 skill 的。
`vsworker/skills/` 列在仓库的 `.prettierignore` 里，所以 vendored 进来的 skill 保持导入时的精确字节。
编辑器和解释器的产物不会被打包：`__pycache__/`、`*.pyc`、`*.pyo`、`.DS_Store`、`Thumbs.db`、
`._*`（AppleDouble 附件）、`__MACOSX/` 和 `.git/` 都会跳过 —— 它们每台机器都不一样，
会让跑 `generate` 那台机器和 CI 算出的 skills 哈希对不上。

#### zip 包

zip 包**只是构建期的源文件格式**。`bundle generate` 读它、把里面的文件内联进去，`bundle check` 再读一遍；
产物里没有 zip，用户机器上也不会解压。

- 要么把文件统一裹一层顶层目录（`zip -r <id>.zip <id>/`），要么把 `SKILL.md` 放在包根
  （`cd <id> && zip -r ../<id>.zip .`）。**只有一层且唯一**的顶层目录会被剥掉，其余原样保留 ——
  所以一个有两个顶层目录的包会因为找不到 `SKILL.md` 而失败。顶层目录名不必等于 `<id>`
  （认身份的是 `SKILL.md` 的 `name`），但不一致会给一条 warning。
- 可执行位取自包里记录的 Unix mode，所以每台机器都一样；Windows 打的包没有 mode，里面一律不可执行。
  除此之外不读宿主的任何信息，这让 zip 在哈希稳定性上比目录**还稍微稳一点**：`core.autocrlf` 改不了
  zip 内部的字节，会做大小写或 Unicode 归一化的文件系统也重命名不了它的条目。
- 逃出 skill 的条目（`../`）、重名条目、符号链接条目、加密条目，以及没有打 UTF-8 标记的非 ASCII 文件名，
  都在构建期直接报错，而不是猜一个。
- `.gitignore` 管不到 zip 包内部，所以上面那份跳过名单是唯一的防线；`generate` 会为每个包打印一条
  「跳过了哪些文件」的 warning。

#### `env.json`

一个 skill 可以带一个 `env.json`，放在它的目录里或它的 zip 包里。
它里面的键值对会成为在该 skill 中运行的 bash 命令的环境变量。
这个形状来自识油平台 —— 它注册 skill 时解析的就是同一个文件：一个**平铺**的 JSON 对象，
不能有注释、不分组、不嵌套。

```jsonc
{ "PLATFORM_BASE_URL": "http://10.68.199.207", "QA_THRESHOLD": "0.69", "GRAPH_ENABLED": "1" }
```

- 值可以是字符串、数字、布尔（`true` → `"1"`）或 `null`（→ `""`）。其它一律报错。
- 键必须长得像环境变量，`[A-Za-z_][A-Za-z0-9_]*`。开头的 `_` 和别的键一样会被导出，因为平台就是这么做的。
- 文件**只要有任何一处问题**就什么都不导出，而不是导出半份配置，并记一条警告。
  在文件本身变化之前，这条警告不会重复。
- `{env:VAR}` 和 `{file:path}` 在加载时按机器替换，跟内置的 MCP 定义完全一样。
  注意 vendored skill 自己的脚本通常也会直接读 `env.json`，它们看到的是占位符原文而不是替换后的值。
  所以占位符只用在「只有宿主会消费」的变量上。

**作用范围。** 一个 skill 的变量会在命令**运行于该 skill 中**时生效：命令的工作目录是该 skill 目录
（或其子目录），或者命令行里点名了它内部的某个路径 —— 绝对路径、相对工作目录的路径、或 `~` 下的路径都算。
光秃秃一个词永远不匹配，所以无关的命令不受影响。两个 skill 因此永远不会在同一个变量名上打架。

**优先级。** skill 的变量会覆盖继承来的环境，也覆盖插件通过 `shell.env` 设的值；
命令里 `KEY=value cmd` 这种前缀按 shell 规则仍然赢在最后。正因为它是覆盖，`env.json` 里写一个
`PATH` 或 `HOME` 会把真的那个替换掉：变量名要起得贴着这个 skill。

这套规则对宿主发现的**任何** skill 都成立，不只是内置的。同事把一个 skill 目录丢进
`~/.config/vsworker/skills/<name>/` 也是同样的行为 —— 这正是定制一个 skill 的办法：
把内置那份拷过去、改它的 `env.json`，磁盘上的那份按名字取胜。

`skill` 工具会把一个 skill 提供了哪些变量告诉模型，**只给名字**。`bundle validate` 和 `bundle generate`
用的是跟产品同一个解析器去读 vendored 的 `env.json`，所以构建时能加载的文件运行时也能加载；
它们还会在「看起来像凭据的键带了明文值」时告警。

## 命令

```bash
bun run --cwd vsworker bundle generate        # 按 manifest 重新生成所有东西
bun run --cwd vsworker bundle check           # CI 闸门：生成物过期就失败
bun run --cwd vsworker bundle check --seams   # CI 闸门：上游合并弄丢了 seam 就失败
bun run --cwd vsworker bundle validate        # 只校验 manifest
bun run --cwd vsworker bundle outdated        # 上游有哪些更新的插件版本 / commit
bun run --cwd vsworker bundle bump <id> [ver] # 重新钉住某个插件的版本，然后重新生成

# 从你自己的全局 opencode 配置导入，然后重新生成
bun run --cwd vsworker bundle import mcp <name> [--from <file>] [--id <id>] [--off]
bun run --cwd vsworker bundle import skill <name> [--from <dir|file.zip>] [--force]
```

`import mcp` 读 `~/.config/vsworker/opencode.json`（或 `--from`），平铺和 `mcp.servers` 两种形状都接受，
把 `enabled` 挪进 `defaultEnabled`，并对明文密钥告警。`import skill` 把
`~/.config/vsworker/skills/<name>` 或 `<name>.zip` 按同名拷进 `vsworker/skills/`，
拷之前先从源里读出 `SKILL.md` —— 能 import 的包就是能 bundle 的包。两者都是追加进 `bundle.jsonc`，
不会破坏里面的注释。

运行时：

```bash
opencode vsworker plugins list|enable <id>|disable <id> [-g]
opencode vsworker mcp     list|enable <id>|disable <id> [-g]
opencode vsworker skills  list|enable <id>|disable <id> [-g]
```

## 用户怎么关掉某一项

每一类用最自然的那个键，全局或按项目都行。同一个键上项目配置优先。

```jsonc
{
  // plugin 和 skill 挂在 vsworker 下面。
  "vsworker": {
    "plugins": { "wakatime": false, "intranet": { "enabled": true, "options": { "url": "http://10.0.0.9" } } },
    "skills": { "report-review": false },
  },
  // MCP server 用的是原生的配置键，不需要任何 fork 特有的东西。
  "mcp": { "intranet-docs": { "enabled": false } },
}
```

要完全覆盖一条内置条目，三类各有一种办法：

- **Plugin**：在普通的 `plugin` 数组里声明同一个 npm 包。
- **MCP server**：写一份完整的 `mcp.<id>` 定义，带上 `type`。注意**没有** `type` 的条目只会保留
  `enabled`，因为配置解码会把其余部分丢掉，所以改一半是做不到的：想改一个 URL 或一个 header，
  就得把整份定义抄过去。
- **Skill**：在 `.opencode/skills/`、`~/.config/vsworker/skills/`、`~/.claude/skills/`
  或任何其它会被发现的位置放一个同名 skill。它会取胜，日志里会记一条重名。

TUI 类的插件走 TUI 自己的机制：`tui.json` 里的 `plugin_enabled`，或者 TUI 内置的插件管理器。
两者都按同一个 `id` 索引。

## 加载顺序与总开关

OpenCode 内置插件先加载，然后是内置打包的插件（按 manifest 顺序），最后是 `plugin` 里的外部插件。
内置的 MCP server 在所有文件和远程来源合并之后才加入配置。内置 skill 在磁盘发现之前注册，
所以磁盘上找到的任何同名 skill 都会覆盖它们。

| 开关                                 | 效果                         |
| ------------------------------------ | ---------------------------- |
| `VSWORKER_DISABLE_BUNDLED_PLUGINS=1` | 只关内置打包的插件           |
| `VSWORKER_DISABLE_BUNDLED_MCP=1`     | 只关内置打包的 MCP server    |
| `VSWORKER_DISABLE_BUNDLED_SKILLS=1`  | 只关内置打包的 skill         |
| `OPENCODE_PURE=1`                    | 上面三样全关，外加外部插件   |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` | 关掉内建插件和内置打包的插件 |

## 被打包的插件能做什么

一个被打包的插件是编译进二进制的，所以在 CLI 里它跑在 `$bunfs` 中，在桌面 app 里跑在一个 Node bundle 中。
它在磁盘上没有属于自己的目录。这排除了：

- 原生模块，以及任何带安装脚本的东西 —— `bun build` 没法把它们内联进来
- 相对 `import.meta.dir` 或 `__dirname` 读资源文件
- `require()` 或动态 `import()` 一个运行时才算出来的路径
- `Bun.*` API，包括 `$` shell —— 桌面端的 sidecar 跑在 Node 上，那里 `input.$` 是 undefined
- 对 TUI 插件而言，`oc-themes` 主题文件和提示音包 —— 两者都需要一个包目录

普通的、调用 SDK 客户端 / 文件系统 / 网络的 JS/TS 没问题。`bundle check` 会对它能检测到的情况告警。

插件是按本仓库自己的 `@opencode-ai/plugin` 做类型检查的，所以上游改了 hook API 会在这里表现为
`bun typecheck` 失败，而不是变成一个坏掉的发布。

## 写自己的内容

拷贝 `plugins/hello/` 或 `skills/hello/`，再加一条 manifest 条目。`hello` 插件是以
`defaultEnabled: false` 打包的，作为这条流水线的冒烟测试，所以在有人打开它之前发布不受影响。
`hello` skill 是开着的，这样不用改任何配置就能端到端检查一个构建。

## 与官方 OpenCode 共存

VsWorker 会和上游 opencode 装在同一批机器上，所以它写的每一样东西都归它自己所有：

|                           | VsWorker                                                                                        | 官方 opencode                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 配置 / 数据 / 状态 / 缓存 | `~/.config/vsworker`、`~/.local/share/vsworker`、`~/.local/state/vsworker`、`~/.cache/vsworker` | 同样的路径，只是换成 `opencode`               |
| 数据库                    | `opencode-vsworker.db`                                                                          | `opencode.db`                                 |
| 桌面 app                  | `VsWorker.app`，bundle id `com.vsworker.desktop`                                                | `OpenCode.app`，`ai.opencode.desktop`         |
| Windows 安装目录          | `%LOCALAPPDATA%\Programs\vsworker-desktop`                                                      | `%LOCALAPPDATA%\Programs\@opencode-aidesktop` |
| 更新器                    | 冻结                                                                                            | npm / brew / curl                             |

Windows 上靠的是同样那两个设置，隔离同样成立。`xdg-basedir` 没有 Windows 特例，所以那四个目录变成
`%USERPROFILE%\.config\vsworker` 及其兄弟；而 app id 决定了 Electron 的用户数据目录
（`%APPDATA%\com.vsworker.desktop`）、把任务栏窗口和开始菜单固定项归组的 AppUserModelID，
以及注册表里的卸载条目。NSIS 的安装目录和更新器缓存则来自 `extraMetadata.name` —— 这正是把它设成
`vsworker-desktop` 的原因：一键的 per-user 安装包按包名而不是产品名命名目录。上游没设这个名字，
所以官方安装包会落到完全另一个地方。

目录名定义在 `packages/core/src/global.ts` 的 `app`。项目级的 `.opencode/` 目录和 `opencode.json`
这个文件名是**刻意共用**的：它们属于一个仓库，不属于一次安装。因此认证是按产品分开的，
provider 要在 VsWorker 里再登录一次。

更新器之所以冻结，是因为上游知道的每一个发布源发的都是 opencode：自动更新会把一个 VsWorker 构建
换成原版 opencode，而 `uninstall` 会对用户另外装的那个包执行 `npm uninstall -g opencode-ai`。
`Installation.method()` 报 `unknown`，`latest()` 报当前运行的版本，`upgrade()` 直接拒绝
（`vsworker/src/release.ts`）。从源码跑和跑测试用的是 `local` 通道，保持上游行为。
桌面的 `vsworker` 通道既没有 publish 目标，也没有 Electron 更新器。

两个 app 在 macOS 和 Windows 上都仍然注册 `opencode://` 这个 URL scheme；VsWorker 不依赖深链接，
所以系统挑中哪个都无所谓。Windows 上的 WSL sidecar 解析的是某个 WSL 发行版**里面**的 `opencode`，
那是用户自己装的一套独立 Linux 环境，不是隔壁那个 Windows app。

### 构建桌面客户端

[PACKAGING.zh.md](./PACKAGING.zh.md) 是构建手册：前置条件、macOS 和 Windows 的命令、每个环境变量决定什么、
产物清单、怎么验证一个构建确实带上了 bundle，以及排错。到 Windows 客户端有两条路：在 macOS 上交叉构建，
或者在一台 Windows PC 上原生构建 —— 后者需要的环境变量更少，但多出一套 C++ 工具链和两项 git 设置。
简版结论是：每一个环节都认 `OPENCODE_CHANNEL=vsworker`；macOS 构建是 ad-hoc 签名，因为这个 fork 没有
Developer ID；而 Windows 构建两条路都是未签名的，所以首次运行会有 SmartScreen 警告。

## 在桌面客户端里管理这些

Settings（`cmd+,` / `Ctrl+,`）里有一个 **Extensions** 区，下面是 **Plugins**、**Skills**、**MCP servers**
三个 tab。每个 tab 会把「这个构建打包了什么」和「用户自己声明了什么」列在一起，并把改动写回 CLI 用的
那些 `opencode.json(c)` 键 —— 所以 UI、CLI、TUI 和手工编辑永远不会互相打架。

- 每个 tab 都有一个 **Global / Project** 开关决定改动落到哪个文件，解析方式和
  `opencode vsworker … -g` 完全一致。
- 写入是在文件锁下用 `jsonc-parser` 做的外科手术式编辑，注释和格式都能保住。
- 每个列表都带着它读到的那个文件的 revision。一次写入会把自己钉在那个 revision 上，
  如果文件在这期间变了就以 409 拒绝，而不是覆盖掉别人的编辑。
- 写完之后实例会被 dispose —— 这正是让一个被切换的 MCP server 或插件真正启动/停止的原因；
  UI 在收到 `global.disposed` 事件后重新拉取。
- 用户自己的 skill 是真实目录：全局是 `~/.config/vsworker/skills/<name>/SKILL.md`，
  项目是 `<worktree>/.opencode/skills/<name>/SKILL.md`。内置 skill、`~/.claude/skills`，
  以及从 `skills.urls` 索引拉来的东西都是只读列出的，因为它们不归我们改写。
- 一条内置的 MCP server 可以被拷进用户配置里去编辑。那是一次分叉，不是打补丁：
  拷贝出来的那份从此不再跟着构建走，正如上面的优先级规则所描述的。

路由是 `GET|POST|PATCH|PUT|DELETE /vsworker/{plugin,skill,skill-source,mcp}`，声明在
`packages/opencode/src/server/routes/instance/httpapi/groups/vsworker.ts`。它们是生成的 SDK 的一部分，
所以改动之后必须跑 `./script/generate.ts`。`vsworker/UPSTREAM.md` 列出了这个功能新增的五处 seam。

## 一个已知的缺口

内置 skill 注册在旧版 skill 服务上 —— 模型、`skill` 工具、斜杠命令和 TUI 的 `/skills` 对话框用的都是它。
`packages/core/src/skill.ts` 里的 V2 skill 服务看不到它们。那个服务今天还没有 TUI 消费方，
也不扫描 `~/.claude/skills`，所以用户能观察到的东西一样都不缺；等 V2 接管 skill 列举时再回来处理这件事。
