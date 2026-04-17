# Task-Notification 机制问题诊断报告

## 问题概述

当 Claude Code 执行后台任务（`run_in_background=true`）完成后，触发的 task-notification 没有被传递给用户。audit.log 中只有 `update.handle` 记录，没有 task-notification 响应记录。

## 根因分析

### 问题定位

问题位于 `src/codex/claude-stream-adapter.ts` 的 `handleMessage` 方法中。

### 核心问题

**`ClaudeStreamAdapter` 只处理存在 `pendingTurn` 的事件，但后台任务的通知在 `pendingTurn` 被清除后才到达。**

### 代码分析

```typescript
// claude-stream-adapter.ts 第 424-476 行
if (parsed.type === "assistant" && worker.pendingTurn) {
  // 处理 assistant 消息...
}

// claude-stream-adapter.ts 第 478-522 行
if (parsed.type === "result" && worker.pendingTurn) {
  const pending = worker.pendingTurn;
  worker.pendingTurn = null;  // ← 关键：pendingTurn 被清除
  // 解析 Promise，结束当前 turn
}
```

### 事件时序问题

```
时间线：
─────────────────────────────────────────────────────────────

T1: 用户发送消息
    └─> sendTurn() 创建 pendingTurn

T2: Claude 处理消息
    ├─> 遇到需要后台执行的工具调用 (run_in_background=true)
    ├─> 返回 "任务已启动" 响应
    └─> 发送 result 事件

T3: adapter 收到 result 事件
    ├─> pendingTurn.resolve()
    └─> worker.pendingTurn = null  ← pendingTurn 被清除

T4: 后台任务完成
    └─> Claude 发送 assistant 消息 (task-notification)

T5: adapter 收到 assistant 事件
    └─> 条件 `worker.pendingTurn` 为 null，消息被忽略！ ← BUG
```

### 根本原因

1. `ClaudeStreamAdapter` 设计为**请求-响应模式**：每个用户消息对应一个 `pendingTurn`，收到 `result` 事件后立即清除 `pendingTurn`
2. **后台任务是异步的**：它在原始 turn 结束后才产生新的 assistant 消息
3. **消息被静默丢弃**：当 task-notification 到达时，`pendingTurn` 已不存在，条件判断失败，消息被忽略

## 影响范围

- 所有使用 `ClaudeStreamAdapter` 的场景（即使用 Claude 引擎的场景）
- 任何触发后台任务的工具调用（如 `Bash` 带 `run_in_background=true`）
- 用户无法收到后台任务完成的通知

## 修复建议

### 方案 1：支持异步消息推送（推荐）

修改 `ClaudeStreamAdapter` 以支持在 `pendingTurn` 不存在时处理 assistant 消息。

**思路**：
1. 添加一个回调机制，用于处理"无 pendingTurn 时的 assistant 消息"
2. 在 `Bridge` 或 `delivery.ts` 中实现消息推送逻辑

**代码修改**：

```typescript
// adapter.ts - 添加回调接口
export interface CodexUserMessageInput {
  // ... 现有字段
  onAsyncMessage?: (text: string) => void;  // 新增：处理异步消息
}

// claude-stream-adapter.ts - handleMessage 方法
if (parsed.type === "assistant") {
  if (worker.pendingTurn) {
    // 现有逻辑：处理当前 turn 的消息
    // ...
  } else {
    // 新增逻辑：处理异步通知（如后台任务完成）
    const content = parsed.message?.content ?? [];
    let text = "";
    for (const item of content) {
      if (item.type === "text" && typeof item.text === "string") {
        text += item.text;
      }
    }
    // 触发回调，将消息推送给用户
    if (text.trim()) {
      this.deliverAsyncMessage?.(text.trim());
    }
  }
}
```

### 方案 2：保持长连接监听

修改架构，在 turn 完成后不清除 worker，而是继续监听可能的异步消息。

**思路**：
1. `result` 事件后不清除 `pendingTurn`，而是标记状态为 "completed"
2. 设置一个超时窗口，在此期间接收的 assistant 消息视为异步通知
3. 超时后再清理资源

### 方案 3：在 delivery 层处理

在 `handleNormalizedTelegramMessage` 中检测后台任务启动，并主动轮询或等待后续通知。

**思路**：
1. 如果响应包含"任务已启动"等关键词，保持 typing 状态
2. 等待额外的响应

## 推荐修复方案

**推荐方案 1**，因为它：
- 改动范围小，风险可控
- 不改变现有请求-响应模型
- 可扩展支持其他异步通知场景

## 验证步骤

1. 修改 `ClaudeStreamAdapter.handleMessage` 方法
2. 添加对 `pendingTurn` 为 null 时 assistant 消息的处理
3. 测试场景：使用 `Bash` 工具带 `run_in_background=true` 执行命令
4. 验证：后台任务完成后，用户应收到完成通知

## 相关文件

- `src/codex/claude-stream-adapter.ts` - 核心问题所在
- `src/codex/adapter.ts` - 接口定义
- `src/telegram/delivery.ts` - 消息投递逻辑
- `src/runtime/bridge.ts` - bridge 层

## 临时 Workaround

在修复完成前，可以：
1. 避免使用 `run_in_background=true`（但这限制了功能）
2. 在系统提示中告诉 Claude 不要使用后台上具（但这不可靠）
