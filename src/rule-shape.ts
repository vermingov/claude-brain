// Whether a thing someone asks the brain to remember is a rule about how to work rather
// than a fact about the world. The CLI and the MCP server both have to answer this before
// they know which endpoint to post to, and neither opens the database, so the test lives
// here rather than beside the rest of the directive logic.
//
// Narrower than the phrasings the prompt hook scans for. "Remember that the API key
// rotates monthly" is a fact someone asked to keep; "remember to rotate the key before
// deploying" is an instruction. Scanning a prompt can afford to be generous because a
// weak match is filed provisionally and has to earn its place; this decides outright
// where the text goes, so it only claims the phrasings that leave no doubt.

const RULE_SHAPE =
	/\b(always|never|from now on|going forward|henceforth|every time|each time|whenever|by default|as a rule|make sure|be sure to|don'?t ever|no longer|only ever)\b/i;

export function looksLikeRule(text: string): boolean {
	return RULE_SHAPE.test(text);
}
