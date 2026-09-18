// Detects an explicit "@ai" summon token in post text.
//
// Matches "@ai" as a standalone handle: at the start or after whitespace or
// an opening bracket/quote, followed by the end, whitespace, or sentence
// punctuation. Rejects e-mail addresses (x@ai.example), other handles
// (@ai_bot, @aiden, @ai.example) and anything glued to a word.
const MENTION_PATTERN = /(?:^|[\s(\[{"'>])@ai(?=$|[\s,;:!?)\]}"']|\.(?=$|\s))/i;

const mentionsAi = (content) => typeof content === 'string' && MENTION_PATTERN.test(content);

module.exports = { mentionsAi, MENTION_PATTERN };
