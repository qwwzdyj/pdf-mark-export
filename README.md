# 档案重点筛选器 · PDF 标注与精简导出

一个轻量网页工具，给预审委员快速在 PDF 上划重点，然后**只导出被标注的那几页**。
未标注的页面会被自动删除，避免助理收到整份冗长文件。

- 所有处理都在浏览器本地完成，**PDF 不会上传到任何服务器**
- 支持电脑与手机触控
- 下划线 / 高亮 两种工具，可选颜色与线宽
- 导出文件名：`原文件名-marked-pages.pdf`

## 在线使用

将本仓库部署到 GitHub Pages 后访问：

```
https://<你的用户名>.github.io/<仓库名>/
```

## 本地运行

任意静态服务器即可。推荐：

```bash
python3 -m http.server 8000
# 然后浏览器访问 http://127.0.0.1:8000/
```

也可直接用 VSCode 的 "Live Server" 等扩展。

> 不要用 `file://` 协议直接打开 `index.html`：pdf.js 的 Worker 需要 HTTP(S)。

## 部署到 GitHub Pages

1. 把本目录推到 GitHub 仓库（默认分支例如 `main`）。
2. 仓库 **Settings → Pages → Source** 选 `Deploy from a branch`，分支选 `main`，目录选 `/ (root)`。
3. 稍等 1–2 分钟，GitHub 会给出访问地址。

仓库根目录已包含 `.nojekyll`，防止 GitHub Pages 误处理 `_` 开头资源。

## 使用流程

1. 点击「上传 PDF」选择本地文件。
2. 在重要段落用鼠标或手指拖动画线（下划线 / 高亮）。
3. 工具栏可切换颜色、线宽，按「撤销」可移除当前页最后一笔，「清空本页」可清掉当前页所有标注。
4. 点击右上角「导出已标注页面」。
5. 浏览器会下载精简版 PDF —— 只包含你画过线的页面，标注会保留。

## 已知限制

- 仅作为重点筛选器，不是完整 PDF 编辑器；不支持评论/批注/OCR/文字级精确选区。
- 加密 PDF 可能无法解析。
- 页面带旋转角度的扫描 PDF，标注位置可能存在偏差；建议先在源文件中纠正旋转再上传。

## 技术栈

- [pdf.js](https://mozilla.github.io/pdf.js/) — 浏览器端 PDF 渲染
- [pdf-lib](https://pdf-lib.js.org/) — 浏览器端 PDF 写出
- 原生 HTML / CSS / JavaScript，无构建步骤

## 数据结构

每一笔标注：

```json
{
  "id": "uuid",
  "page": 3,
  "type": "underline",
  "x1": 120,
  "y1": 450,
  "x2": 520,
  "y2": 450,
  "color": "#e22b2b",
  "width": 4
}
```

坐标使用 PDF 用户空间（原点在页面左下角，单位为 pt），导出时直接写入新 PDF。
