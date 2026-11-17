# GCAM-China Studio

GCAM-China v8 的情景与数据工作台。在一个桌面程序里完成这条链路：改数据 → 用 R 的 gcamdata 生成 XML → 调用 `gcam.exe` 求解 → 用 ModelInterface 从数据库导出 CSV。每套参数放在独立的 Profile 里，基线数据不会被改写。

当前版本 **0.1.1**。程序本身不含 GCAM 模型、Java 和 R，这三样仍要装在本机，并在「设置」里填上路径。

## 交给同事时发什么

推荐将免安装目录包发给已有旧版的同事：退出旧程序，把新包中的 `win-unpacked` 放到原 `GCAM-Studio\release` 下替换同名目录，保留原来的 `GCAM-Studio\data`。双击 `win-unpacked\GCAM-China Studio.exe` 即可沿用原有设置和 Profile。

| 文件 | 用途 |
| --- | --- |
| `GCAM-China-Studio-0.1.1-win-unpacked.zip` | 已展开的免安装程序；推荐用于替换旧版。 |
| `release\GCAM-China-Studio-0.1.1-setup.exe` | 安装版。 |
| `release\GCAM-China-Studio-0.1.1-portable.exe` | 单文件免安装，双击即用。 |
| `GCAM-China-Studio-0.1.1-source.zip` | 精简源码；不含运行时、依赖、个人数据及模型。源码构建见文末。 |

交付包与验收说明位于项目上一级的 `output/studio-repair-20261117`。程序包内包含后端与所需 R 包；GCAM 模型、64 位 JDK 21、R 4.4.x 主程序仍需要在同事电脑安装并在设置中选择。

源码开发可运行 `tools/setup-runtime.ps1` 安装依赖。原有命令行入口 `启动.bat` 可修复从旧完整源码包复制来的 Python 虚拟环境；依赖下载先经本地代理，连续失败三次后记录并改为直连。没有 Python 时使用上面的免安装程序。

启动脚本保存为 UTF-8（无 BOM）+ CRLF。脚本开头如果发现控制台不是 UTF-8（65001），会先切换代码页，再用新的 cmd 重新运行自己。这样中文提示在 GBK 和 UTF-8 系统上都能正确解析。用记事本等工具修改这个文件后，要确认它仍然是 UTF-8 编码、没有 BOM。

`data\settings.json` 里如果有这台电脑上不存在的路径，例如数据目录、Rscript、Java，启动时会先退回默认值，再自动检测本机的 R 和 Java。模型根目录要同事在「设置」页填写自己电脑上的路径。

`release` 里现在只保留这次打出来的文件：

| 文件 | 用途 |
| --- | --- |
| `release\GCAM-China-Studio-0.1.1-setup.exe` | 安装版。可选安装目录，当前用户安装，不需要管理员。 |
| `release\GCAM-China-Studio-0.1.1-portable.exe` | 单文件免安装。双击后自行展开再启动。 |
| `release\win-unpacked\GCAM-China Studio.exe` | 已经展开的免安装目录。适合和源码放在一起直接运行。 |

源码根目录的 `启动 GCAM Studio.bat` 会启动 `release\win-unpacked` 里的程序。这个目录不存在时，才会改用开发模式。

安装包没有代码签名。Windows SmartScreen 或公司的应用控制策略可能提示未知发布者，内部使用时选择「仍要运行」。如果拦截的是 `gcam.exe` 而不是 Studio 本身，见文末的 WinError 4551。

## 同事电脑上第一次打开

安装版和单文件免安装版的数据默认放在：

```text
%APPDATA%\gcam-china-studio\data
```

从源码目录里的 `win-unpacked` 启动时，如果旁边能找到 `GCAM-Studio\data\settings.json`，则继续使用这份源码里的数据目录。

打开后进入「设置与诊断」。路径可以手填，也可以点输入框右侧的「浏览」：模型目录和 Studio 数据目录会打开文件夹选择框，Rscript 和 Java 会打开文件选择框。按本机实际情况选好并保存：

1. **GCAM 模型根目录**。必须是包含 `exe\`、`input\`、`output\` 的那一层。例如 `D:\GCAM_CHINA\GCAM_TOOL`。不要填成 `exe` 子目录。
2. **Rscript.exe**。gcamdata 生成 XML 用，需要能运行本仓库 `runtime\r-lib` 里的包。开发机上是 R 4.4.2。
3. **java.exe**。需要 JDK 21。GCAM 求解要用同目录旁的 `jvm.dll`，查询要用 `java.exe`。
4. **Studio 数据目录**。只放 Profile、构建、运行和查询结果。它不是模型目录。

保存后看「环境自检」。相关检查项都是绿色再去新建 Profile 或运行。模型目录、R、Java 留空或写成相对路径时，保存会被拒绝。

自检缺文件时，运行日志会写出具体缺哪一个，以及要回设置页改哪一项。

## 三种运行方式

### 安装

运行 `release\GCAM-China-Studio-0.1.1-setup.exe`，选一个目录完成安装，从开始菜单或桌面快捷方式打开。

卸载不会删除 `%APPDATA%\gcam-china-studio`。Profile 和运行结果还在那里。

### 单文件免安装

双击 `release\GCAM-China-Studio-0.1.1-portable.exe`。它会在临时位置展开后再启动，不写开始菜单。数据仍在上面的 AppData 目录，不在 exe 旁边。

### 解压目录 / 和源码一起运行

双击 `启动 GCAM Studio.bat`，或直接运行：

```text
release\win-unpacked\GCAM-China Studio.exe
```

这个入口和源码在同一棵目录里时，Studio 数据目录就是 `GCAM-Studio\data`。同事如果整目录拷走，第一次要到设置里把模型根目录、R、Java 改成自己机器上的路径。源码里的 `data\settings.json` 记录的是打包那台电脑的路径。

## 从源码修改和重新打包

前置：Node.js 20.19+、Python 3.11+、64 位 JDK 21、R 4.4.x，以及一套 GCAM-China v8 目录。首次克隆后先运行 `tools/setup-runtime.ps1` 创建 `runtime\venv` 并安装依赖。

开发模式会同时打开后端 `127.0.0.1:8765`、前端 `127.0.0.1:5173` 和 Electron 窗口：

```bat
cd /d <GCAM-Studio 所在目录>
npm run dev
```

只开后端：

```bat
runtime\venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8765
```

只开前端：

```bat
npm run dev:web
```

后端测试：

```bat
npm run test:backend
```

重新打包（前端、PyInstaller 后端、安装包、免安装 exe、`win-unpacked`）：

```bat
npm run build
```

`pyinstaller` 要能在 `runtime\venv\Scripts` 里找到。打包结果写到 `release\`。

## Studio 数据目录和模型目录

这两处不能混用。

| | GCAM 模型根目录 | Studio 数据目录 |
| --- | --- | --- |
| 里面有什么 | `exe\gcam.exe`、`input\gcamdata`、`output\modelinterface` | Profile、gcamdata 构建、GCAM 运行、查询 CSV、`studio.db` |
| 会不会被改写 | 基线 input 不会被改。通过独立日志配置，直接在该次运行目录的 `logs` 内写日志 | 这是 Studio 自己的工作区 |
| 默认位置 | 设置里保存的绝对路径 | 见上文「第一次打开」 |

在设置里修改 Studio 数据目录并保存时：

- 当前目录里如果已有 Profile、构建、运行记录或查询结果，会迁到新目录。同一块磁盘是直接改名，跨磁盘是复制核对后再删源文件。
- `manifest.json`、运行用的 `configuration.xml`，以及 `studio.db` 里的绝对路径会改成新目录。已结束运行的 BaseX 二进制库只搬家，不改内容。
- `settings.json` 留在原来的启动目录，用来记住新路径。不要手工把它搬走，否则下次启动会以为还是默认位置。
- 当前目录只有空的 `profiles`、`cache`、`logs` 和一张空表时，只切换路径，不会覆盖目标里已经存在的 Profile。
- 两边都已经有 Profile 或数据库记录时，保存会被拒绝，避免互相覆盖。请换一个空目录，或继续使用已有数据的那个目录。
- 新目录不能放在旧目录里面，旧目录也不能放在新目录里面。
- 有构建、求解或查询正在排队或运行时，不能改数据目录。
- 数据目录和模型根目录都必须是绝对路径，例如 `D:\GCAMStudioData`。

迁移完成后界面会写出旧路径和新路径。模型根目录、Java、R 修改后建议退出程序再打开，让已经启动的子进程使用新环境。

## 一次正常的使用顺序

1. 设置里确认模型目录、R、Java 都是绿色。
2. 新建 Profile。名称可以是中文，磁盘上的 id 只会保留英文、数字、下划线和连字符。GCAM 和 Java 打不开带中文的目录名。
3. 在「数据文件」里改 CSV。没改过的文件继续用基线，不会复制一整份 gcamdata。
4. 需要改情景组件、政策或 `configuration.xml` 时，在对应页面编辑，改动记在这个 Profile 里。
5. 到「运行中心」运行。没有改过 CSV 时，会跳过 gcamdata，直接复用基线 XML。改过 CSV 时，会先做一份 gcamdata 硬链接镜像，只把改过的文件换成真实副本，再调用 R。
6. 运行成功后，到「结果」里选 ModelInterface 查询，导出 CSV 或 Excel。也可以把多次结果放在一起对比。

「快速验证（标准精度，至2025）」保留模型的标准 solver，只缩短计算时间范围到 2025 年或更早。旧版低精度模式已移除。验证结果在运行历史中明确标记；正式情景请关闭快速验证，并选择需要的停止年。

队列同一时间只跑一个任务。可以给多个 Profile 排队，但不能在任务进行中改数据目录。

## 数据放在哪里

```text
<Studio 数据目录>\
  settings.json                         仅当这里同时是启动目录时才有
  studio.db                             Profile 索引和查询结果记录
  profiles\<id>\
    profile.json
    config.xml                          该 Profile 的 configuration
    overlay\gcamdata\...                只保存改过的 CSV / 数据文件
    builds\<build-id>\                  gcamdata 镜像、XML、build.log
    runs\<run-id>\
      configuration.xml
      database_basexdb\                 GCAM 的 BaseX 数据库
      gcam.log
      results\                          查询导出
```

模型侧对应关系：

```text
<GCAM 模型根目录>\
  exe\gcam.exe
  exe\configuration_*.xml               新建 Profile 时复制的模板
  input\gcamdata\                       基线。Studio 不修改这里
  input\gcamdata\xml\                   没有 CSV 改动时复用的基线 XML
  output\modelinterface\ModelInterface.jar
  output\queries\Main_queries.xml
```

## 目录（源码）

```text
GCAM-Studio\
  backend\          FastAPI。入口是 backend\run_server.py
  frontend\         React + Ant Design
  desktop\          Electron 主进程
  runtime\venv\     打包和开发用的 Python 环境
  runtime\r-lib\    gcamdata 运行时的 R 包，会打进安装包
  data\             从源码树启动时的 Studio 数据
  build\            PyInstaller spec 和中间产物
  release\          安装包、免安装 exe、win-unpacked
```

## 中文路径和 R: 盘

GCAM 的 C++/Java 不能稳定打开带中文的绝对路径。

- 模型根目录是纯英文时，直接运行该目录下的 `exe\gcam.exe`，不创建虚拟盘。`D:\GCAM_CHINA\GCAM_TOOL` 属于这种情况。
- 模型根目录含有中文等非 ASCII 字符时，启动时用 `subst` 建一个 ASCII 盘，默认 `R:`。`R:` 已被占用就依次试 `S:`、`T:`、`U:`。传给 `gcam.exe` 和 ModelInterface 的模型路径会改写到这个盘里。
- 每次使用映射前会核验盘符实际指向当前模型，避免误用另一套模型。
- 模型目录外的中文 Studio 数据目录会另用 V:–Z: 的空闲盘符。没有可用盘符时会给出明确错误。

## WinError 4551

日志里如果出现：

```text
[WinError 4551] 应用程序控制策略已阻止此文件
```

这是 Windows 的 AppLocker、WDAC 或 Smart App Control 拒绝启动程序，不是 GCAM 求解失败。

旧版不管模型在哪，都会把求解器转成 `R:\exe\gcam.exe`。有些策略不认 `subst` 出来的盘，所以纯英文模型目录现在改为直接启动真实的 `gcam.exe`。策略如果按文件哈希、签名或真实路径拦截 `gcam.exe`，换路径仍然会被拦。需要 IT 把该 `gcam.exe` 加入允许规则，并按单位 IT 的应用控制流程处理。Studio 现在会在日志里写明被拦的是哪一个文件。

后端自己起不来时，会弹出「无法启动」，详细输出在：

```text
%APPDATA%\gcam-china-studio\backend.log
```

## R 包

`runtime\r-lib` 里是 gcamdata 的 `driver()` 需要的包：dplyr、tidyr、readr、data.table、stringr、pkgload 等。没有安装 `renv.lock` 里的全部包，因为这里不跑 drake / devtools。

换一台机器、R 版本不一致时，用那台机器的 Rscript 把这些包装进 `runtime\r-lib`，再重新打包。包名见 `backend\app\services\r_build.py` 里的运行脚本，以及本目录原有的安装记录。

## 已知限制

- 第一次有 CSV 改动的 gcamdata 全量构建大约 20–40 分钟，生成的 XML 大约 5 GB。之后用硬链接，不会把基线再复制一份。
- Excel 目前只能查看和下载，不能在表格里编辑。CSV 可以编辑、批量缩放、和基线比较、恢复基线。
- 查询预览只取前面一部分行，导出的 CSV 是完整的。
- 跨磁盘迁移大的 BaseX 库时，设置页会一直等到复制结束。界面请求上限是 10 分钟。
- 安装包未签名。

## 0.1.1 运行与结果校验

- CSV 构建用输入内容签名判断是否失效，恢复/删除覆盖文件或更换模型都会重新选择构建。情景 XML 的覆盖文件会进入实际运行配置。
- 复制 Profile 只复制配置和覆盖输入，构建及运行重新生成，不引用旧 Profile 的绝对路径。
- 成功、失败、取消、构建失败都会保留运行 manifest。后端异常退出的任务下次启动显示 interrupted。
- 每次运行有独立 log_conf.xml 和 logs；日志断线后按事件序号续传。长时间求解暂时没有新日志不代表进程已经退出。
- 成功需要退出码 0、所有计算期收敛、校准检查通过及有效 BaseX 文件。数据库存在或单独出现 Model exiting successfully 不能证明结果有效。
- 查询目录和结果 ID 独立，Java 失败不会复用旧 CSV。运行中可取消 R、GCAM 和查询 Java 进程。
- 按日志确认实际完成年份；部分年份运行的查询 CSV 会去掉后续尚未求解的初始化值，图表与导出均包含已求解的 2100 年。快速验证结果不能代替完整目标年的正式结果。
- 排队/运行期间禁止修改同一 Profile 的输入，以及更换模型、工具和数据目录。关闭桌面程序会结束它的后台进程树。
- 环境自检实际检查 64 位 JDK 21、jvm.dll 和所需 R 包加载，结果缓存两分钟。

后端回归：`npm run test:backend`。前端类型检查：`node node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json`。

从 GitHub 克隆的源码不包含 Python、R 包、node_modules、个人设置和模型数据。在已安装 Python 3.11+、R 4.4.x、Node.js 20.19+ 的 Windows PowerShell 中运行 `powershell -ExecutionPolicy Bypass -File tools/setup-runtime.ps1`，再执行 `npm run build`。下载先通过 `http://127.0.0.1:1080`；当前操作连续失败三次后记录并改用直连。可用 `-ProxyUri` 指定本机代理协议。模型、64 位 JDK 21 和 R 主程序仍由使用者安装并在设置里选择。

Windows 子进程使用受支持的 UTF-8 locale，避免继承 C.UTF-8 后把现有 R 包误判为缺失。XML 编辑器及 worker 随前端打包，编辑时不依赖 CDN。CSV 支持 gzip、保留合法 NA 缺失标记，并拒绝 NaN/Infinity 数值写入。

## 0.1.1 本机验收记录（2026-11-17）

- 标准 SSP2 基线完整计算至 2100：所有计算期收敛，校准检查通过，退出码 0；数据库查询导出 435 行，检查 9570 个数值均有限。
- 在隔离 Profile 修改一处 2100 年建筑技术成本 CSV：R 生成 304 个 XML，原始 CSV 哈希不变；新 XML 以标准精度计算至 2025，通过全部计算期并生成数据库；查询导出 435 行，按实际求解范围保留 3045 个有限数值。
- 后端回归覆盖构建失效、恢复基线、XML 覆盖、硬链接隔离、失败与取消留证、日志截断、查询失败、NA/gzip 和 2100 年结果。
- 浏览器验收拦截全部外网请求，验证本地 XML 编辑器键盘编辑、保存回读与中文数据目录别名；CSV 夹具验证迟到响应、跨 Profile 保存目标、回车/失焦去重。
- XML 与 CSV 编辑在加载期间锁定输入；快速切换文件或 Profile 后，旧响应和旧保存回调不能覆盖当前目标。

这些记录验证软件链路和所列情景；正式研究运行仍需按实际目标年完整求解，并检查该次运行的收敛和校准状态。
