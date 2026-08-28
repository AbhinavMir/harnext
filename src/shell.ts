/** Quote one argument for the POSIX shell commands harnext prints. */
export function shellQuote(value: string): string {
	if (value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
