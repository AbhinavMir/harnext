import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { ompAdapter } from "./omp.js";
import { piAdapter } from "./pi.js";
import type { HarnessAdapter, HarnessId } from "./types.js";

/** Add one adapter here to expose a harness to discovery, transfer, sync, and resume. */
export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = [claudeAdapter, piAdapter, ompAdapter, codexAdapter];

export function harnessAdapter(id: HarnessId): HarnessAdapter {
	const adapter = HARNESS_ADAPTERS.find((candidate) => candidate.id === id);
	if (adapter === undefined) throw new Error(`Unsupported harness: ${id}`);
	return adapter;
}

export type { ActiveChatEvidence, AdapterWriteResult, CurrentHarnessChat, HarnessAdapter, HarnessId, HarnessSessionInfo, HeadlessOptions, HeadlessSpec, WriteChatOptions } from "./types.js";
