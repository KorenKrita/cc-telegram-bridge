import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileWorkflowStore } from "../src/state/file-workflow-store.js";

describe("FileWorkflowStore", () => {
  it("lists records newest-first and clears a single upload", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await store.append({
        uploadId: "one",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["a.zip"],
        derivedFiles: [],
        summary: "first",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.append({
        uploadId: "two",
        chatId: 100,
        userId: 100,
        kind: "document",
        status: "failed",
        sourceFiles: ["b.pdf"],
        derivedFiles: [],
        summary: "second",
        createdAt: "2026-04-10T00:01:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      });

      expect((await store.list({ chatId: 100 })).map((record) => record.uploadId)).toEqual(["two", "one"]);
      await store.remove("one");
      expect((await store.list({ chatId: 100 })).map((record) => record.uploadId)).toEqual(["two"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("finds uploads by id and filters list results", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const store = new FileWorkflowStore(stateDir);

    try {
      await store.append({
        uploadId: "one",
        chatId: 100,
        userId: 100,
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: ["a.zip"],
        derivedFiles: [],
        summary: "first",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.append({
        uploadId: "two",
        chatId: 200,
        userId: 200,
        kind: "document",
        status: "failed",
        sourceFiles: ["b.pdf"],
        derivedFiles: [],
        summary: "second",
        createdAt: "2026-04-10T00:01:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      });

      await expect(store.find("two")).resolves.toEqual(
        expect.objectContaining({ uploadId: "two", chatId: 200, status: "failed" }),
      );
      expect((await store.list({ status: "failed" })).map((record) => record.uploadId)).toEqual(["two"]);
      expect((await store.list({ chatId: 100, status: "awaiting_continue" })).map((record) => record.uploadId)).toEqual(["one"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
