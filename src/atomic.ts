import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

/** Replace a text file without exposing readers to a partial JSONL write. */
export async function writeTextFile(path: string, content: string, overwrite: boolean): Promise<void> {
	if (!overwrite) {
		await writeFile(path, content, { flag: "wx" });
		return;
	}
	const temporary = `${path}.harnext-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(temporary, content, { flag: "wx" });
	await rename(temporary, path);
}
