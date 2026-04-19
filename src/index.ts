import { runCli } from "./commands/cli.js";
import { acquireInstanceLock } from "./state/instance-lock.js";
import { resolveConfig } from "./config.js";
import {
  createServiceDependencies,
  parseServiceInstanceName,
  pollTelegramUpdates,
  registerBotCommands,
  resolveServiceEnvForInstance,
} from "./service.js";
import { loadBusConfig } from "./bus/bus-config.js";
import { createBusServer, startBusServer, stopBusServer } from "./bus/bus-server.js";
import { createBusTalkHandler } from "./bus/bus-handler.js";
import { pruneStaleInstances, registerInstance, deregisterInstance, resolveChannelRoot } from "./bus/bus-registry.js";
import { UsageStore } from "./state/usage-store.js";
import { GroupHandler } from "./telegram/group-handler.js";
import { chunkTelegramMessage } from "./telegram/message-renderer.js";
import { loadInstanceConfig } from "./telegram/instance-config.js";
import type { GroupMessageInput } from "./telegram/types.js";

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);

    if (await runCli(argv)) {
      return;
    }

    const instanceName = parseServiceInstanceName(argv);
    const resolvedEnv = await resolveServiceEnvForInstance(
      {
        HOME: process.env.HOME,
        APPDATA: process.env.APPDATA,
        USERPROFILE: process.env.USERPROFILE,
        CODEX_HOME: process.env.CODEX_HOME,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CODEX_TELEGRAM_STATE_DIR: process.env.CODEX_TELEGRAM_STATE_DIR,
        CODEX_EXECUTABLE: process.env.CODEX_EXECUTABLE,
        CLAUDE_EXECUTABLE: process.env.CLAUDE_EXECUTABLE,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      },
      instanceName,
    );

    const serviceConfig = resolveConfig(resolvedEnv);
    const instanceLock = await acquireInstanceLock(serviceConfig.stateDir);
    const releaseLockOnExit = () => {
      instanceLock.releaseSync();
    };

    process.once("exit", releaseLockOnExit);

    const abortController = new AbortController();
    const shutdown = () => {
      abortController.abort();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    const { api, bridge, config } = await createServiceDependencies(resolvedEnv);
    await registerBotCommands(api);

    let busServer: ReturnType<typeof createBusServer> | null = null;
    const channelRoot = resolveChannelRoot(config.stateDir);
    const busConfig = await loadBusConfig(config.stateDir);

    if (busConfig) {
      // Clear out entries for instances that have exited (PID no longer
      // alive). Keeps cross-instance /ask from connecting to dead ports.
      await pruneStaleInstances(channelRoot);

      const handler = createBusTalkHandler({
        bridge,
        stateDir: config.stateDir,
        instanceName,
      });

      busServer = createBusServer(instanceName, config.stateDir, handler, busConfig.secret);
      const boundPort = await startBusServer(busServer, busConfig.port);
      await registerInstance(channelRoot, instanceName, boundPort, busConfig.secret);
      console.log(`Bus server listening on 127.0.0.1:${boundPort}`);
    }

    // Load instance config to get allowed group chat IDs
    const instanceConfig = await loadInstanceConfig(config.stateDir);
    const allowedChatIds = instanceConfig.groupChatIds ?? [];

    // Start group handler if allowed chat IDs are configured
    let groupHandler: GroupHandler | null = null;
    if (allowedChatIds.length > 0) {
      groupHandler = new GroupHandler({
        botToken: config.telegramBotToken,
        allowedChatIds,
        onMessage: async (input: GroupMessageInput) => {
          console.log(`[GroupHandler] onMessage triggered: chatId=${input.chatId}, messageId=${input.messageId}, isMentioned=${input.routing.isMentioned}, isReply=${input.routing.isReply}`);

          // Send typing indicator
          try {
            await api.sendChatAction(input.chatId, "typing");
            console.log(`[GroupHandler] Typing indicator sent to chat ${input.chatId}`);
          } catch (typingErr) {
            console.warn(`[GroupHandler] Failed to send typing indicator:`, typingErr);
          }

          let response;
          try {
            console.log(`[GroupHandler] Calling bridge.handleGroupMessage for chat ${input.chatId}...`);
            response = await bridge.handleGroupMessage({
              ...input,
              locale: "zh",
              sendMessage: async (chatId: number, text: string) => {
                await api.sendMessage(chatId, text);
              },
              stateDir: serviceConfig.stateDir,
              onProgress: (partialText: string) => {
                console.log(`[GroupHandler] Progress: ${partialText.slice(0, 50)}...`);
              },
              onAsyncMessage: (text: string) => {
                console.log(`[GroupHandler] Async message: ${text.slice(0, 100)}...`);
                // Send async messages (like compaction notices) immediately
                api.sendMessage(input.chatId, text).catch((err) => {
                  console.error(`[GroupHandler] Failed to send async message:`, err);
                });
              },
            });
            console.log(`[GroupHandler] bridge.handleGroupMessage completed, response length: ${response.text.length}`);
          } catch (err) {
            console.error(`[GroupHandler] bridge.handleGroupMessage failed:`, err);
            const errorMessage = err instanceof Error ? err.message : String(err);
            try {
              await api.sendMessage(input.chatId, `❌ 处理失败: ${errorMessage}`);
            } catch (sendErr) {
              console.error(`[GroupHandler] Failed to send error message:`, sendErr);
            }
            return;
          }

          // Send the response back to the group chat
          try {
            console.log(`[GroupHandler] Sending response to chat ${input.chatId}, text length: ${response.text.length}`);
            const chunks = chunkTelegramMessage(response.text);
            for (const chunk of chunks) {
              await api.sendMessage(input.chatId, chunk);
            }
            console.log(`[GroupHandler] Response sent successfully to chat ${input.chatId} (${chunks.length} chunk(s))`);

            if (response.usage) {
              console.log(`[GroupHandler] Usage: inputTokens=${response.usage.inputTokens}, outputTokens=${response.usage.outputTokens}`);
            }
          } catch (sendErr) {
            console.error(`[GroupHandler] Failed to send response:`, sendErr);
          }
        },
      });
      await groupHandler.start();
    } else {
      console.log("[Main] groupChatIds not configured in config.json, group handler disabled");
    }

    try {
      await pollTelegramUpdates(api, bridge, config.inboxDir, console, abortController.signal, instanceName, groupHandler ?? undefined);
    } finally {
      if (groupHandler) {
        await groupHandler.stop();
      }
      if (busServer) {
        await stopBusServer(busServer);
        await deregisterInstance(channelRoot, instanceName);
      }
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
      process.removeListener("exit", releaseLockOnExit);
      await instanceLock.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
