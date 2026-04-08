import { describe, expect, it } from "vitest";

import { ChatQueue } from "../src/runtime/chat-queue.js";

describe("ChatQueue", () => {
  it("serializes jobs per chat", async () => {
    const queue = new ChatQueue();
    const events: string[] = [];

    await Promise.all([
      queue.enqueue(1, async () => {
        events.push("start-1");
        await new Promise((resolve) => setTimeout(resolve, 25));
        events.push("end-1");
      }),
      queue.enqueue(1, async () => {
        events.push("start-2");
        events.push("end-2");
      }),
    ]);

    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("cleans up settled entries and keeps running after rejection", async () => {
    const queue = new ChatQueue();
    const events: string[] = [];

    await queue
      .enqueue(1, async () => {
        events.push("reject-start");
        throw new Error("boom");
      })
      .then(
        () => {
          throw new Error("expected rejection");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("boom");
        },
      );

    expect((queue as unknown as { queues: Map<number, unknown> }).queues.size).toBe(0);

    await queue.enqueue(1, async () => {
      events.push("recover-start");
    });

    expect(events).toEqual(["reject-start", "recover-start"]);
  });
});
