# paper-download

一个围绕 CNKI 文献检索与思学图书馆下载的自动化项目，当前包含两条主线：

1. `Chinese paper search/cnkiLRspider`
   - 研究主题 -> Kimi 讨论检索策略 -> CNKI 检索 -> 结果整理 -> 候选下载队列
2. `src`
   - 思学图书馆登录 -> 文献下载 -> 入口1 -> 检索1 -> 代理 CNKI -> 下载页 -> 文件落盘

项目当前面向 Windows + PowerShell 环境维护。

## 当前状态

已经落地的能力：

- 思学图书馆登录态复用
- 登录验证码截图 -> Kimi OCR -> 自动填写
- 思学老路径下载模块
- 代理 CNKI 检索
- `篇关摘` 固定检索流程
- CNKI 高级检索 / 专业检索自动化
- CNKI 滑块验证码处理
- 研究主题到 `papers_for_download.csv` / `download_queue.csv` 的管线

当前推荐的使用方式：

- 搜索与候选整理：走 Python 管线
- 真正下载：走 Node.js 的老路径下载模块

## 目录结构

```text
paper-download/
├─ src/
│  ├─ legacy-sixue-download.js     # 思学老路径下载模块
│  ├─ download-paper.js            # 旧的直接论文页下载器
│  ├─ library-auth.js              # 思学登录与登录态复用
│  ├─ library-captcha.js           # 文本验证码截图 + Kimi OCR
│  ├─ live-session.js              # 可视化人工接管调试入口
│  └─ common.js                    # 通用工具
├─ Chinese paper search/
│  └─ cnkiLRspider/
│     ├─ research_pipeline.py      # 搜索主流程
│     ├─ full_research_download_pipeline.py
│     ├─ cnki_entry.py
│     ├─ cnki_captcha.py
│     ├─ cnki_common.py
│     └─ README_LOCAL.md
├─ downloads/                      # 下载落盘目录
├─ outputs/                        # 运行截图、HTML、日志
├─ state/                          # 登录态，如 auth.json
├─ selectors.json                  # 当前选择器配置
├─ selectors.example.json          # 选择器模板
└─ .env.example                    # 环境变量模板
```

## 安装

```powershell
cd D:\Code\paper-download
npm install
```

Python 管线依赖见：

[README_LOCAL.md](/D:/Code/paper-download/Chinese%20paper%20search/cnkiLRspider/README_LOCAL.md)

## 配置

1. 复制环境变量模板

```powershell
Copy-Item .env.example .env
```

2. 复制选择器模板

```powershell
Copy-Item selectors.example.json selectors.json
```

3. 根据实际页面微调 `selectors.json`

## 主要脚本

### 1. 思学老路径下载

这是当前建议保留和继续演进的下载入口：

```powershell
node .\src\legacy-sixue-download.js
```

也可以用环境变量指定查询词：

```powershell
$env:LEGACY_QUERY = "《岳阳楼记》中的忧乐精神与儒家文化探析"
$env:LEGACY_TITLE = "《岳阳楼记》中的忧乐精神与儒家文化探析"
node .\src\legacy-sixue-download.js
```

它的链路是：

`思学首页 -> 文献下载 -> 入口1 -> 检索1 -> 代理CNKI -> 篇关摘 -> 结果 -> cdown下载页 -> 文件`

### 2. 思学登录与会话复用

登录逻辑在：

- [library-auth.js](/D:/Code/paper-download/src/library-auth.js)
- [library-captcha.js](/D:/Code/paper-download/src/library-captcha.js)

行为是：

- 优先复用 `AUTH_STATE_PATH`
- 登录态失效时，自动重新登录
- 遇到文本验证码时，自动截图并调用 Kimi OCR

### 3. 研究检索主流程

```powershell
cd "D:\Code\paper-download\Chinese paper search\cnkiLRspider"
python research_pipeline.py --topic-file .\topic.txt
```

产物通常包括：

- `strategy_round1.json`
- `papers_master.csv`
- `papers_for_download.csv`
- `download_queue.csv`

## 人类化节奏约束

思学老路径下载模块已经内置：

- 点击前随机停顿
- 点击后随机停顿
- 页面跳转后额外观察
- 下载页单独处理

设计原则：

- 稳定优先
- 准确优先
- 不追求盲目提速

## GitHub 迁移建议

迁移前先看：

[docs/GITHUB_MIGRATION.md](/D:/Code/paper-download/docs/GITHUB_MIGRATION.md)

重点注意：

- 不要提交 `.env`
- 不要提交 `state/auth.json`
- 不要提交 `outputs/`、`downloads/`
- 不要提交任何真实账号密码

## 重要文档

- [思学老路径操作说明](/D:/Code/paper-download/操作流程-思学图书馆到知网下载.md)
- [本地运行说明](/D:/Code/paper-download/Chinese%20paper%20search/cnkiLRspider/README_LOCAL.md)
- [变更记录](/D:/Code/paper-download/CHANGELOG.md)

## 当前建议

如果你之后要在新窗口直接跑，建议优先走这两步：

1. 先用 `legacy-sixue-download.js` 单独验证思学老路径
2. 再把它接到下载队列里做批量下载
