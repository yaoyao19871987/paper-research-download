# GitHub 迁移说明

这份说明用于把当前项目迁移到 GitHub 时，尽量避免把本地敏感信息、会话态和运行产物一起带上去。

## 1. 不要提交的内容

- `.env`
- `state/auth.json`
- `outputs/`
- `downloads/`
- 任意验证码截图
- 任意运行日志中可能带有真实链接、会话参数或账号信息的文件

这些内容已经在根目录 `.gitignore` 中做了默认忽略。

## 2. 建议提交的核心内容

- `src/`
- `Chinese paper search/cnkiLRspider/`
- `package.json`
- `package-lock.json`
- `.env.example`
- `selectors.example.json`
- `README.md`
- `CHANGELOG.md`
- `docs/`

## 3. 迁移前建议检查

1. 确认 `selectors.json` 是否包含本机临时调试选择器
2. 确认任何文档中没有真实账号密码
3. 确认输出目录中的截图没有被误放进版本库
4. 确认 Python 管线读取的本地密钥路径在新环境里是否还成立

## 4. 新环境最小准备

### Node

```powershell
npm install
```

### Python

进入：

`D:\Code\paper-download\Chinese paper search\cnkiLRspider`

按该目录自己的说明安装依赖。

## 5. 新环境首次运行建议顺序

1. 先复制 `.env.example` 为 `.env`
2. 先复制 `selectors.example.json` 为 `selectors.json`
3. 先单测思学登录
4. 再单测 `legacy-sixue-download.js`
5. 最后再跑整条研究管线

## 6. 推荐保留的模块边界

为了后续迁移、重构和替换，建议保持下面的边界不变：

- `library-captcha.js`
  - 只负责文本验证码识别
- `library-auth.js`
  - 只负责思学登录和会话复用
- `legacy-sixue-download.js`
  - 只负责思学老路径下载
- `research_pipeline.py`
  - 只负责研究主题到下载候选队列

## 7. 后续如果拆仓库

如果未来要拆成两个仓库，建议按下面拆：

1. `paper-search-pipeline`
   - `Chinese paper search/cnkiLRspider`
2. `sixue-cnki-downloader`
   - `src`
   - `selectors.example.json`
   - `.env.example`

这样搜索链路和下载链路可以独立维护。
