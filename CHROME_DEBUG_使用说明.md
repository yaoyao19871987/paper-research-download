# Chrome 调试复用说明

目标：让 CNKI 自动化复用你手动过验证后的 Chrome 会话，而不是每次新开一个浏览器。

## 1. 启动带调试端口的 Chrome

在项目根目录运行：

```powershell
cd D:\Code\paper-download
.\start-cnki-chrome-debug.cmd
```

注意：

- 如果你要复用当前登录态，先把所有 Chrome 窗口关掉，再运行这个脚本。
- 脚本会把 Chrome 以 `127.0.0.1:9222` 调试模式拉起来，并直接打开 CNKI 高级检索页。

## 2. 在这个 Chrome 里做人工动作

只在这个新开的 Chrome 里操作：

- 登录
- 过滑块验证
- 打开需要的 CNKI 页面

后面的自动化会接管这个浏览器会话。

## 3. 运行研究流水线

在项目根目录运行：

```powershell
cd D:\Code\paper-download
.\run-cnki-pipeline-debug.cmd
```

如果要继续已有 run，也可以手动运行：

```powershell
cd "D:\Code\paper-download\Chinese paper search\cnkiLRspider"
$env:CNKI_BROWSER = "chrome"
$env:CNKI_DEBUGGER_ADDRESS = "127.0.0.1:9222"
python research_pipeline.py --topic-file .\topic.txt --approve-strategy
```

## 4. 当前状态检查

如果脚本能成功接上 Chrome，`9222` 端口应该是打开的。

如果你看到自动化又自己新开浏览器，通常说明：

- 你不是在调试模式 Chrome 里操作
- 或者 `9222` 端口没开
- 或者当前 shell 里没设置 `CNKI_DEBUGGER_ADDRESS`
