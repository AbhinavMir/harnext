/** Local export redaction. Prompt text never leaves the machine. */

import {
	englishDataset,
	englishRecommendedTransformers,
	fixedPhraseCensorStrategy,
	RegExpMatcher,
	TextCensor,
} from "obscenity";

const matcher = new RegExpMatcher({
	...englishDataset.build(),
	...englishRecommendedTransformers,
});
const censor = new TextCensor().setStrategy(fixedPhraseCensorStrategy("[redacted]"));

export interface RedactionResult {
	text: string;
	matches: number;
}

/** Redact locally using Obscenity's English dataset. This covers broader profanity, not only identity slurs. */
export function redactText(text: string): RedactionResult {
	const matches = matcher.getAllMatches(text, true);
	return { text: censor.applyTo(text, matches), matches: matches.length };
}
