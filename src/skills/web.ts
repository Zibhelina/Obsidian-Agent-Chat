import type { Skill } from "./types";

const WEB_PROMPT = `## Web search skill (active)

The user has explicitly activated the /web skill for this turn. Treat web search as **required**, not optional, for answering this request.

Expectations:

- Invoke whichever web-search / browsing route is most appropriate for the query. Possible routes include gateway tools (\`web_search\`, \`web_extract\`, \`browser\`, \`search\`, etc.) and, when the active provider is Codex, Codex's native web search via a delegated CLI call such as \`codex exec --json 'use native web search ...'\`.
- Do not treat Codex native search as mandatory or exclusive. It is one available search route. Decide per query which route is best: Hermes gateway search for fast direct lookup, browser/extract for page interaction or full-page reading, Codex native search when provider-specific/native Codex retrieval is useful, or multiple/all available routes when cross-checking matters.
- Do not answer from memory alone — the user picked this skill because they want grounded, current information.
- Prefer multiple sources when claims are non-trivial. Cross-check surprising or high-stakes facts, and use more than one search route when that materially improves coverage or confidence.
- Cite inline. For each substantive claim, include a link to the source in the form \`([source](https://…))\` or a numbered footnote you resolve at the bottom. The user needs to be able to verify.
- Note freshness. If a source is dated, include the date. If the landscape is known to change quickly (prices, scores, live events, recent news) and your sources are old, flag that.

If **no web-search tool is available** in this environment:

- Do **not** pretend you searched. Do **not** fabricate URLs, citations, or "according to…" attributions.
- Say plainly: "I don't have a web-search tool available in this Hermes configuration. Here's what I know from training, but it may be out of date — enable a web-search tool in the gateway for grounded answers."
- Then answer from memory with explicit uncertainty markers on anything time-sensitive.`;

export const webSkill: Skill = {
  id: "web",
  label: "Web search",
  description: "Force the model to use web search and cite sources; no answering from memory.",
  icon: "globe",
  placeholder: "Search the web",
  systemPrompt: WEB_PROMPT,
};
