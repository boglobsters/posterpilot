import { describe, expect, it } from 'vitest';
import {
	chosenSetFor,
	fillSlotKey,
	missingSetSlots,
	type FillCandidate
} from './episode-fill-policy';

describe('chosenSetFor', () => {
	it('picks the set most of the title cards came from', () => {
		expect(
			chosenSetFor([
				{ kind: 'poster', provider: 'mediux', setId: 'other' },
				{ kind: 'poster', provider: 'mediux', setId: 'other' },
				{ kind: 'title_card', provider: 'mediux', setId: 'cards' },
				{ kind: 'title_card', provider: 'mediux', setId: 'cards' },
				{ kind: 'title_card', provider: 'mediux', setId: 'stray' }
			])
		).toEqual({ provider: 'mediux', setId: 'cards' });
	});

	it('falls back to season artwork when no title cards were chosen', () => {
		expect(chosenSetFor([{ kind: 'poster', provider: 'theposterdb', setId: 'seasons' }])).toEqual({
			provider: 'theposterdb',
			setId: 'seasons'
		});
	});

	it('returns null when nothing came from a set', () => {
		expect(chosenSetFor([])).toBeNull();
		expect(chosenSetFor([{ kind: 'title_card', provider: null, setId: null }])).toBeNull();
	});
});

describe('missingSetSlots', () => {
	const card = (id: number, season: number, episode: number): FillCandidate => ({
		id,
		kind: 'title_card',
		season,
		episode
	});

	it('returns only season-level slots nobody filled, one per slot, in order', () => {
		const candidates: FillCandidate[] = [
			{ id: 1, kind: 'poster', season: null, episode: null },
			{ id: 2, kind: 'background', season: null, episode: null },
			card(5, 1, 2),
			card(3, 1, 1),
			card(4, 1, 1),
			{ id: 6, kind: 'season', season: 2, episode: null },
			card(7, 2, 1)
		];
		const filled = new Set([fillSlotKey({ kind: 'title_card', season: 1, episode: 1 })]);
		expect(
			missingSetSlots(candidates, filled).map(({ candidate, slot }) => [candidate.id, slot])
		).toEqual([
			[5, { kind: 'title_card', season: 1, episode: 2 }],
			[6, { kind: 'poster', season: 2, episode: null }],
			[7, { kind: 'title_card', season: 2, episode: 1 }]
		]);
	});

	it('keeps the lowest candidate id when the set repeats a slot', () => {
		expect(missingSetSlots([card(9, 1, 1), card(4, 1, 1)], new Set())[0].candidate.id).toBe(4);
	});

	it('returns nothing when every slot is already filled', () => {
		const filled = new Set([fillSlotKey({ kind: 'title_card', season: 1, episode: 1 })]);
		expect(missingSetSlots([card(1, 1, 1)], filled)).toEqual([]);
	});
});
