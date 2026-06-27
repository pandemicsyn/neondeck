import { readFileSync } from 'node:fs';

export type Soul = {
	name: string;
	emoji: string;
	vibe: string;
};

const fallbackSoul: Soul = {
	name: 'neondeck',
	emoji: '🟢',
	vibe: 'A calm, concise, technical companion for a developer side display.',
};

export function loadSoul(path = './SOUL.md'): Soul {
	try {
		return parseSoul(readFileSync(path, 'utf8'));
	} catch {
		return fallbackSoul;
	}
}

export function soulInstructions(soul = loadSoul()) {
	return [
		'Agent soul:',
		`- Name: ${soul.name}`,
		`- Emoji: ${soul.emoji}`,
		'- Vibe:',
		soul.vibe,
		'Adopt this soul consistently at the start of every session while still following all higher-priority system, developer, and application instructions.',
	].join('\n');
}

function parseSoul(markdown: string): Soul {
	const name = readField(markdown, 'name') ?? fallbackSoul.name;
	const emoji = readField(markdown, 'emoji') ?? fallbackSoul.emoji;
	const vibe = readSection(markdown, 'Vibe') ?? fallbackSoul.vibe;

	return {
		name: name.trim(),
		emoji: emoji.trim(),
		vibe: vibe.trim(),
	};
}

function readField(markdown: string, field: string) {
	const pattern = new RegExp(`^${field}:\\s*(.+)$`, 'im');
	return markdown.match(pattern)?.[1];
}

function readSection(markdown: string, heading: string) {
	const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s+|\\s*$)`, 'im');
	return markdown.match(pattern)?.[1];
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
