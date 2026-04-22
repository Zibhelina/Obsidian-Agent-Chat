// Slash commands are now backed by the skill registry — see src/skills/.
// This file used to hold a stale hard-coded list of Hermes CLI commands that
// were typed literally into the model without effect. Keep this module as a
// thin shim so older imports don't break while we migrate callers.

import { SkillRegistry, type Skill } from "../skills";

const registry = new SkillRegistry();

export function filterCommands(query: string): string[] {
	return registry.filter(query).map((s) => s.id);
}

export function getSkillRegistry(): SkillRegistry {
	return registry;
}

export function getSkill(id: string): Skill | undefined {
	return registry.get(id);
}

