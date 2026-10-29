# 视频转换

在自己的电脑上把多个视频转成另一种格式。文件不会上传到网络，转换由本机的 [FFmpeg](https://ffmpeg.org/) 完成。

支持 MP4、AVI、MKV、MOV、WebM、FLV、WMV、MPEG。

## 环境

- Windows
- [Node.js](https://nodejs.org/) 20 或更高版本
- FFmpeg，并且能在终端里运行 `ffmpeg`

如果 FFmpeg 不在系统 PATH 里，可以设置环境变量 `FFMPEG_PATH`，指向 `ffmpeg.exe` 的完整路径。

## 使用

界面操作：

<video src="https://raw.githubusercontent.com/hcc0007/videos-convert-app/main/ui-demo.mp4" width="720" controls playsinline></video>

[ui-demo.mp4](./ui-demo.mp4)

```bash
npm install
npm run build:web
```

然后双击 `start.bat`，或在项目目录运行：

```bash
npm run open
```

浏览器会打开 `http://127.0.0.1:3927`。

1. 选择要转换的视频。
2. 选择来源格式和目标格式。
3. 选择保存文件夹。
4. 点击「开始转换」。一次最多同时转换 3 个视频。

有显卡时，MP4、MKV、MOV、FLV 会优先用显卡编码。没有可用显卡时，改用更快的软件编码。

输出文件名与原视频相同，扩展名换成目标格式。例如 `假期.mp4` 转成 AVI 后是 `假期.avi`。如果输出路径和源文件是同一个文件，会保存为 `假期 (converted).mp4`，避免覆盖原片。

## 转换控制

- 输出文件夹里已经有同名成品时，列表会标成「已转换」，再次开始时会跳过，不会另存一份带序号的副本。
- 每个视频可以单独「暂停 / 继续」。正在转换的文件会停住进度，继续后接着转。
- 「删除」会把该视频移出本次任务。正在转换的会停掉，并清掉未完成的临时文件；已经转好的成品不会被删掉。
- 页面底部可以「全部暂停」。全部停住后，按钮变成「全部继续」。
- 「全部取消」会停掉还没完成的文件，并清掉临时文件。已经完成的保留。

## 开发

同时启动转换服务和网页开发服务器：

```bash
npm start
```

只启动转换服务：

```bash
npm run server
```

转换服务只监听 `127.0.0.1:3927`。
