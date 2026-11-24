/**
 * Fork-only (boglobsters/posterpilot): rules for filling artwork for episodes and seasons
 * added after a show's set was applied. Pure, so it can be unit-tested without a database.
 *
 * Only season-level slots (season posters/backgrounds and episode title cards) are ever
 * filled, only from the set already chosen for the show, and only where PosterPilot has
 * never applied anything — so a show's curated root artwork and every card already in
 * place are left alone.
 */
import { normalizeSlot } from '$lib/server/posters/automatic-selection';

export interface ChosenSlotSelection {
	kind: 'poster' | 'background' | 'title_card';
	provider: string | null;
	setId: string | null;
}

export interface ChosenSet {
	provider: string;
	setId: string;
}

/**
 * The set a show's season/episode artwork was chosen from: the most common
 * (provider, set) among its stored selections, counting title cards first because they
 * are what new episodes need. Null when nothing was chosen from a set.
 */
export function chosenSetFor(selections: ChosenSlotSelection[]): ChosenSet | null {
	const tally = (rows: ChosenSlotSelection[]) => {
		const counts = new Map<string, { set: ChosenSet; count: number }>();
		for (const row of rows) {
			if (!row.provider || !row.setId) continue;
			const key = `${row.provider}\u0000${row.setId}`;
			const entry = counts.get(key) ?? {
				set: { provider: row.provider, setId: row.setId },
				count: 0
			};
			entry.count++;
			counts.set(key, entry);
		}
		return [...counts.values()].sort(
			(a, b) =>
				b.count - a.count ||
				a.set.provider.localeCompare(b.set.provider) ||
				a.set.setId.localeCompare(b.set.setId)
		)[0]?.set;
	};
	return tally(selections.filter((row) => row.kind === 'title_card')) ?? tally(selections) ?? null;
}

export interface FillCandidate {
	id: number;
	kind: 'poster' | 'background' | 'season' | 'title_card';
	season: number | null;
	episode: number | null;
}

export interface FillSlot {
	kind: 'poster' | 'background' | 'title_card';
	season: number;
	episode: number | null;
}

export function fillSlotKey(slot: {
	kind: string;
	season: number | null;
	episode: number | null;
}): string {
	return `${slot.kind}:${slot.season ?? 'root'}:${slot.episode ?? 'root'}`;
}

/**
 * The chosen set's candidates for season-level slots PosterPilot has never filled, one
 * per slot (the lowest candidate id when a set repeats a slot), in slot order.
 */
export function missingSetSlots<T extends FillCandidate>(
	setCandidates: T[],
	filledSlotKeys: ReadonlySet<string>
): Array<{ candidate: T; slot: FillSlot }> {
	const bySlot = new Map<string, { candidate: T; slot: FillSlot }>();
	for (const candidate of [...setCandidates].sort((a, b) => a.id - b.id)) {
		const slot = normalizeSlot(candidate);
		if (!slot || slot.season === null) continue;
		const key = fillSlotKey(slot);
		if (filledSlotKeys.has(key) || bySlot.has(key)) continue;
		bySlot.set(key, { candidate, slot: { ...slot, season: slot.season } });
	}
	return [...bySlot.values()].sort(
		(a, b) =>
			a.slot.season - b.slot.season ||
			(a.slot.episode ?? -1) - (b.slot.episode ?? -1) ||
			a.slot.kind.localeCompare(b.slot.kind)
	);
}
