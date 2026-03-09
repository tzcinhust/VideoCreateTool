# AI短剧创作智能体工作流程

## 1. 整体架构
- 后端：`main.py`，使用 Flask 提供统一接口 `/api/agent/run`。
- 前端：多页面结构 + 统一脚本状态管理。
  - 主页面：`templates/index.html`（导航入口）
  - 次级页面：`templates/studio.html`、`templates/visual.html`、`templates/export_center.html`
  - 公共资源：`static/app.js` + `static/style.css`
- 模型：千问（Qwen），通过 `.env` 中的 `DASHSCOPE_API_KEY` 调用 DashScope OpenAI 兼容接口。

### 前端页面分层
- 主页面（Home）：只承载产品简介与入口导航，保持简洁。
- 创作工坊页（Studio）：故事引擎、剧本工坊、分镜基础生成、全局命令。
- 可视化编辑页（Visual）：角色关系图直连编辑 + 情节时间线拖拽。
- 导出中心页（Export Center）：Markdown/Word/PDF 统一导出。
- 视频实验室页（Video Lab）：短剧脚本生成 + 文生视频任务创建与状态查询。
- 跨页面状态：使用浏览器 `localStorage` 存储 `story_card/workshop/storyboard`，页面切换不丢数据。

## 2.5 视频生成流程（千问 + 万相）
1. 在 `video-lab` 输入题材、设定、人物与风格。
2. 调用 `POST /api/video/script`：由千问生成短剧脚本与视频提示词。
3. 调用 `POST /api/video/create-task`：提交文生视频任务（异步，返回 `task_id`）。
4. 调用 `GET /api/video/task/<task_id>`：轮询任务状态。
  - 前端支持自动轮询（默认开启，15 秒/次），也支持手动停止。
5. 当状态 `SUCCEEDED` 时获取 `video_url` 并播放/下载（URL 24h 内有效）。

## 2. 三层创作流程

### 第一层：故事引擎（story_engine）
- 输入：一句话创意 + 可选主题/基调/结构模板偏好。
- 后端处理：
  - 构建故事引擎提示词。
  - 调用千问生成结构化 JSON。
- 输出：`story_card`，包括 logline、核心冲突、结构锚点、开场钩子、结局类型。

### 第二层：剧本工坊（workshop）
- 输入：`story_card` + 角色要求 + 情节要求。
- 后端处理：
  - 让模型输出角色标签、角色关系、情节节点、对白与动作草稿。
  - 每个节点附带一致性检查提示。
- 输出：`characters`、`relationships`、`plot_nodes`、时间线视图和卡片墙分组。

### 第二层可视化编辑：角色关系图 + 时间线拖拽
- 角色关系图：
  - 使用可视化图谱展示 `characters` 与 `relationships`。
  - 支持在前端通过“起点角色 + 终点角色 + 关系类型 + 冲突点”新增/更新关系。
  - 支持删除已选关系，操作后实时刷新图谱并同步数据。
- 情节时间线拖拽：
  - 将 `plot_nodes` 渲染为可拖动卡片列表。
  - 拖拽后自动更新 `timeline_view` 与 `plot_nodes` 顺序。
  - 新顺序会继续影响分镜生成与导出内容。

### 第三层：分镜工厂（storyboard）
- 输入：`workshop` 结果 + 视觉风格要求。
- 后端处理：
  - 将情节节点转换为镜头列表。
  - 自动生成景别、运镜、画面描述、对白/音效、时长估算。
- 输出：`storyboards`、总时长估算、拍摄检查清单。

## 3. 全局自然语言指令（command）
- 用户可在任意阶段输入自然语言指令，例如：
  - `/为反派增加一个动机`
  - `/将第三个场景改为夜间下雨`
  - `/总结当前剧本的矛盾点`
- 后端会把当前项目状态与命令一起发送给模型，返回：
  - `updated_state`：更新后的故事卡/工坊/分镜状态
  - `consistency_report`：一致性结果
  - `suggestions`：下一步建议

## 4. 导出（export）
- 前端点击“生成 Markdown 导出稿”。
- 后端将三层结果合并为结构化 Markdown：
  - 故事卡
  - 角色设定
  - 情节脉络
  - 分镜表
- 可用于后续复制到 Word、协作文档或继续加工为拍摄脚本。

## 5. 真正文件导出（Word/PDF）
- Word 导出接口：`POST /api/export/docx`
  - 输入：当前项目状态（`story_card`、`workshop`、`storyboard`）
  - 输出：二进制 `.docx` 文件下载
- PDF 导出接口：`POST /api/export/pdf`
  - 输入：当前项目状态
  - 输出：二进制 `.pdf` 文件下载
- 前端提供两个按钮直接触发下载，不再需要手动复制 Markdown。
- PDF 使用内置 CJK 字体 `STSong-Light`，避免依赖本地字体文件。

## 6. 数据与状态流
1. 前端维护运行态：`story_card` -> `workshop` -> `storyboard`。
2. 每次按钮触发都调用 `/api/agent/run` 并传入 `stage + payload`。
3. 返回结果写回前端状态并展示。
4. `command` 阶段可覆盖性更新状态，实现连续编辑。

## 7. 启动方式
```bash
cd video_create
pip install -r requirements.txt
python main.py
```

浏览器访问：`http://127.0.0.1:8000`

## 8. 可扩展方向
- 增加 Word/PDF 文件导出。
- 增加角色关系图可视化（例如基于 ECharts）。
- 增加时间线拖拽排序与分镜批量编辑。
- 增加本地数据库持久化（SQLite）支持项目保存/回溯。
