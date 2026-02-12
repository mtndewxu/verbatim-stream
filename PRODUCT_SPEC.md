# Verbatim Stream — 实时语音翻译应用

## 产品概述

Verbatim Stream 是一款移动优先的实时语音翻译 Web 应用。用户选择源语言和目标语言后，应用实时监听语音、转录并翻译，翻译结果以对话气泡形式逐条显示。采用"双轮精炼"策略：第一轮即时翻译保证响应速度，第二轮静默优化最近两条翻译以提升专业术语一致性和上下文连贯性。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript + Vite |
| 样式 | Tailwind CSS + shadcn/ui 组件库 |
| 路由 | react-router-dom v6 |
| 后端 | Supabase Edge Functions (Deno) |
| 语音识别 (STT) | ElevenLabs Scribe v2（主）/ Deepgram Nova-2（备） |
| 翻译 | OpenAI GPT-5-nano |
| 语音合成 (TTS) | ElevenLabs eleven_turbo_v2_5 |

---

## 支持语言

| 代码 | 语言 | 旗帜 |
|------|------|------|
| en | English | 🇺🇸 |
| zh | 中文 | 🇨🇳 |
| ja | 日本語 | 🇯🇵 |
| ko | 한국어 | 🇰🇷 |
| es | Español | 🇪🇸 |
| fr | Français | 🇫🇷 |
| de | Deutsch | 🇩🇪 |
| pt | Português | 🇧🇷 |
| ru | Русский | 🇷🇺 |
| ar | العربية | 🇸🇦 |

---

## 应用结构

单页应用 (SPA)，只有一个主页面 `/`，包含两个核心模式：

### 模式一：Monitor（监听模式）

- **用途**：被动监听他人讲话并实时翻译
- **交互**：点击"Monitor"按钮开始/停止
- **行为**：
  1. 打开麦克风，STT 引擎持续转录
  2. 每当 STT 返回 `isFinal` 片段，将其追加到当前文本块
  3. 用累积的完整文本调用翻译（全文重译策略，保证语义连贯）
  4. 翻译结果实时显示在活跃气泡中
  5. 停止监听时，当前块定稿为一条 `ConversationEntry`
  6. 触发第二轮精炼（见下文）

### 模式二：Console（控制台模式）

- **用途**：用户主动说话，获取翻译并可播放语音
- **交互**：按住录音按钮说话，松开停止
- **行为**：
  1. 录音期间实时转录和翻译（同 Monitor）
  2. 松开后定稿，触发精炼
  3. 每条翻译旁有播放按钮，点击调用 TTS 朗读翻译结果
  4. 再次点击可停止播放

---

## 核心机制：双轮精炼 (Rolling Refinement)

```
isFinal 片段到达
  │
  ▼
第一轮：translateText(累积全文) → 立即更新 UI（灰色文字 text-muted-foreground）
  │
  ▼
第二轮：refineTranslation(最近2条) → 静默更新 UI（过渡到正常文字色，transition-colors 700ms）
```

### 第一轮（即时翻译）
- 每个 `isFinal` 片段触发
- 使用累积的完整文本块调用 `translate` 端点
- 结果立即显示，文字颜色为 `text-muted-foreground`（表示草稿状态）

### 第二轮（上下文精炼）
- 在新条目定稿后触发
- 取最近 2 条 `ConversationEntry` 的翻译文本
- 调用 `refine-translation` 端点
- 返回精炼后的翻译，替换原文本
- 文字颜色过渡到 `text-foreground`，带 700ms 过渡动画
- 使用序列号（`refinementSeq`）丢弃过期响应

### 停止时行为
1. 停止 STT
2. 等待所有未完成的第一轮翻译
3. 定稿当前块
4. 触发最后一次精炼
5. 等待精炼完成后才算真正停止

---

## 数据模型

```typescript
interface ConversationEntry {
  id: string;           // crypto.randomUUID()
  original: string;     // 原文转录
  translated: string;   // 翻译结果
  timestamp: Date;
  refined: boolean;     // false=草稿, true=已精炼
}
```

---

## 后端 Edge Functions

### 1. `translate`
- **方法**：POST
- **请求体**：`{ text: string, fromLang: string, toLang: string }`
- **响应**：`{ translation: string }`
- **模型**：GPT-5-nano
- **Prompt 策略**：系统提示要求只返回翻译结果，不加解释

### 2. `refine-translation`
- **方法**：POST
- **请求体**：`{ sentences: string[], fromLang: string, toLang: string }`
- **响应**：`{ refinements: string[] }`
- **模型**：GPT-5-nano
- **Prompt 策略**：要求审查连续两句翻译的术语一致性、自然流畅度和准确性

### 3. `elevenlabs-tts`
- **方法**：POST
- **请求体**：`{ text: string }`
- **响应**：音频二进制流 (audio/mpeg)
- **模型**：eleven_turbo_v2_5

### 4. `elevenlabs-scribe-token`
- **方法**：GET
- **响应**：`{ signed_url: string }`
- **用途**：为客户端 ElevenLabs STT 生成临时认证 URL

### 5. `deepgram-token`
- **方法**：GET
- **响应**：`{ token: string }`
- **用途**：为客户端 Deepgram STT 生成临时 API Key（有效期 50 秒）

---

## STT 引擎切换

应用支持两个 STT 引擎，可在界面顶部切换：

### ElevenLabs Scribe v2（默认）
- 使用 WebSocket 连接 `wss://api.elevenlabs.io/v1/speech-to-text/ws`
- 内置 VAD（语音活动检测）
- 语言代码格式：ISO 639-1（如 `zh`、`en`）

### Deepgram Nova-2
- 使用 WebSocket 连接 `wss://api.deepgram.com/v1/listen`
- 通过 AudioWorklet 采集 PCM 音频
- 语言代码格式：BCP 47（如 `zh-CN`、`en-US`）

两个引擎共享同一个 Hook 接口：
```typescript
interface TranscriberHook {
  start(langCode: string): Promise<void>;
  stop(): void;
  transcript: string;
  isFinal: boolean;
  listening: boolean;
}
```

---

## UI 布局

### 整体结构
- 移动优先设计，最大宽度 `max-w-md`，居中显示
- 顶部：应用标题 + 语言选择器 + STT 引擎切换
- 中部：对话记录滚动区域
- 底部：模式切换标签（Monitor / Console）+ 操作按钮

### 语言选择器
- 两个药丸形按钮（源语言、目标语言）
- 显示国旗 emoji + 语言名
- 点击弹出下拉菜单选择语言
- 中间有交换按钮可互换语言

### 对话气泡
- 原文显示在上方（较小字体，`text-muted-foreground`）
- 翻译显示在下方（正常字体）
- 未精炼的翻译文字颜色较浅
- 精炼完成后文字颜色加深，带平滑过渡

### Console 模式额外元素
- 播放按钮：点击朗读翻译结果
- 播放中显示旋转动画

---

## 并发控制

### 翻译序列号 (`translationSeq`)
- 每次翻译请求递增
- 响应返回时检查序列号，丢弃过期结果
- 防止慢速翻译覆盖最新结果

### 精炼序列号 (`refinementSeq`)
- 同上，用于精炼请求
- 确保只有最新的精炼结果被应用

### Token 预缓存
- 应用挂载时预请求 STT Token
- ElevenLabs：缓存 `signed_url`，一次性使用
- Deepgram：缓存 token，有效期 50 秒

---

## 环境变量

| 变量 | 用途 |
|------|------|
| `VITE_SUPABASE_URL` | Supabase 项目 URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase 匿名密钥 |
| `OPENAI_API_KEY`（服务端） | OpenAI API 密钥，用于翻译和精炼 |
| `ELEVENLABS_API_KEY`（服务端） | ElevenLabs API 密钥，用于 TTS 和 STT Token |
| `DEEPGRAM_API_KEY`（服务端） | Deepgram API 密钥，用于 STT Token |

---

## 设计规范

- **配色**：深色主题为主，使用 HSL 语义化 CSS 变量
- **字体**：系统字体栈
- **圆角**：统一使用设计系统的 `--radius` 变量
- **动画**：精炼过渡使用 `transition-colors duration-700`
- **组件库**：shadcn/ui（基于 Radix UI）

---

## 不包含的功能

- 无用户认证 / 登录注册
- 无数据库持久化（所有对话仅存在于当前会话）
- 无多设备同步
- 无离线支持
- 无对话导出
