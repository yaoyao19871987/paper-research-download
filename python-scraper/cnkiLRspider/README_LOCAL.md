# CNKI 本地运行说明

这个目录负责“研究主题 -> 检索策略 -> CNKI 检索 -> 候选下载清单”。

## 主要能力

- Kimi 讨论研究主题
- 生成 CNKI 专业检索表达式
- 自动打开 CNKI 高级检索 / 专业检索
- 自动处理 CNKI 滑块验证码
- 抓取结果并去重
- 产出 `papers_for_download.csv` / `download_queue.csv`

## 关键入口

- [research_pipeline.py](/D:/Code/paper-download/Chinese%20paper%20search/cnkiLRspider/research_pipeline.py)
- [full_research_download_pipeline.py](/D:/Code/paper-download/Chinese%20paper%20search/cnkiLRspider/full_research_download_pipeline.py)

## 安装

```powershell
cd "D:\Code\paper-download\Chinese paper search\cnkiLRspider"
python -m pip install -r requirements.txt
```

## 凭据说明

当前代码默认从共享层读取模型密钥与凭据。迁移到新环境时，需要确认这些依赖是否还存在。

如果新环境没有共享层，至少要解决：

- Kimi API 凭据
- SiliconFlow API 凭据

## 最常用运行方式

### 1. 用 UTF-8 主题文件运行

```powershell
Set-Content -Path .\topic.txt -Value "岳阳楼记相关的文献资料" -Encoding UTF8
python research_pipeline.py --topic-file .\topic.txt
```

### 2. 直接恢复已有运行目录

```powershell
python research_pipeline.py --topic-file .\topic.txt --resume-dir "D:\Code\paper-download\Chinese paper search\cnkiLRspider\outputs\<existing-run>"
```

### 3. 自动批准策略

```powershell
python research_pipeline.py --topic-file .\topic.txt --approve-strategy
```

### 4. 自动批准下载选择

```powershell
python research_pipeline.py --topic-file .\topic.txt --resume-dir "D:\Code\paper-download\Chinese paper search\cnkiLRspider\outputs\<existing-run>" --approve-selection
```

## 常用环境变量

```powershell
$env:CNKI_VERIFY_TIMEOUT = "600"
$env:CNKI_MAX_PAGES_PER_VIEW = "1"
$env:CNKI_MAP_BATCH_SIZE = "4"
$env:CNKI_DOWNLOAD_CANDIDATES = "15"
$env:EXPERT_MEETING_PAUSE_SECONDS = "1.5"
```

## 浏览器相关

支持复用已打开的调试浏览器。

### 1. 启动 Edge 或 Chrome 调试端口

```powershell
msedge --remote-debugging-port=9222
```

### 2. 让管线附着到现有浏览器

```powershell
$env:CNKI_DEBUGGER_ADDRESS = "127.0.0.1:9222"
python research_pipeline.py --topic-file .\topic.txt
```

## 输出目录

每次运行会写到：

`D:\Code\paper-download\Chinese paper search\cnkiLRspider\outputs\<topic>-<timestamp>\`

常见输出：

- `strategy_round1.json`
- `papers_master.csv`
- `papers_for_download.csv`
- `download_queue.csv`
- `run_status.json`
- `analysis_summary.md`

## 当前边界

这个目录当前只负责“搜”和“整理候选”。

真正通过思学老路径去下文件的能力，已经拆到根目录：

- [legacy-sixue-download.js](/D:/Code/paper-download/src/legacy-sixue-download.js)

## 建议联动方式

推荐的整体顺序：

1. 在这里跑出 `papers_for_download.csv`
2. 生成 `download_queue.csv`
3. 把目标标题交给根目录的老路径下载模块逐篇下载
