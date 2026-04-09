import path from "node:path";
import { JsonStore } from "./json-store.js";

export interface UsageRecord {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  requestCount: number;
  lastUpdatedAt: string;
}

const defaultUsage: UsageRecord = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCachedTokens: 0,
  totalCostUsd: 0,
  requestCount: 0,
  lastUpdatedAt: "",
};

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
}

export class UsageStore {
  private readonly store: JsonStore<UsageRecord>;

  constructor(stateDir: string) {
    this.store = new JsonStore<UsageRecord>(path.join(stateDir, "usage.json"));
  }

  async load(): Promise<UsageRecord> {
    return await this.store.read({ ...defaultUsage });
  }

  async record(turn: TurnUsage): Promise<void> {
    const current = await this.load();
    current.totalInputTokens += turn.inputTokens;
    current.totalOutputTokens += turn.outputTokens;
    current.totalCachedTokens += turn.cachedTokens ?? 0;
    current.totalCostUsd += turn.costUsd ?? 0;
    current.requestCount += 1;
    current.lastUpdatedAt = new Date().toISOString();
    await this.store.write(current);
  }
}
