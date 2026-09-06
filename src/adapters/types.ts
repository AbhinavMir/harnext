/** The seam implemented by every supported coding-harness adapter. */

import type { Transcript } from "../ir.js";

export type HarnessId = "claude" | "pi" | "omp" | "codex";

export interface HarnessSessionInfo {
	path: string;
	sessionId: string;
	cwd: string;
	modifiedAt: number;
	title?: string;
	firstPrompt?: string;
	archived?: boolean;
}

export interface WriteChatOptions {
	path?: string;
	sessionId?: string;
	overwrite?: boolean;
	name?: string;
}

export interface AdapterWriteResult {
	path: string;
	sessionId: string;
}

export interface CurrentHarnessChat {
	path?: string;
	sessionId?: string;
}

export interface ActiveChatEvidence {
	paths?: string[];
	sessionIds?: string[];
}

export interface HeadlessOptions {
	cwd: string;
	sessionId?: string;
	yolo?: boolean;
}

export interface HeadlessSpec {
	command: string;
	args: string[];
	input?: string;
}

export interface HarnessAdapter {
	id: HarnessId;
	label: string;
	command: string;
	storeRoots(): string[];
	findRepoChats(cwd: string): Promise<HarnessSessionInfo[]>;
	read(path: string): Promise<Transcript>;
	write(transcript: Transcript, options: WriteChatOptions): Promise<AdapterWriteResult>;
	resumeCommand(sessionId: string, cwd: string): string;
	currentChat(): CurrentHarnessChat | undefined;
	processMatches(command: string): boolean;
	sessionProcessMatches(command: string, sessionId: string): boolean;
	activeChats?(processCommands: string[]): Promise<ActiveChatEvidence>;
	headless(prompt: string, options: HeadlessOptions): HeadlessSpec;
}
