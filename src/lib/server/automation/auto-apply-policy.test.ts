import { describe, expect, it } from 'vitest';
import { autoApplySkipReason, type AutoApplyCandidateState } from './auto-apply-policy';

const fresh: AutoApplyCandidateState = {
	hasCandidates: true,
	reviewedAt: null,
	externalArtworkChangedAt: null,
	selectedPosterUrl: null,
	selectedBackgroundUrl: null,
	hasChildSelections: false,
	hasSuccessfulApply: false
};

describe('autoApplySkipReason', () => {
	it('allows an untouched item that discovery found artwork for', () => {
		expect(autoApplySkipReason(fresh)).toBeNull();
	});

	it.each([
		[{ hasCandidates: false }, 'no_candidates'],
		[{ hasSuccessfulApply: true }, 'already_applied'],
		[{ reviewedAt: new Date(0) }, 'reviewed'],
		[{ selectedPosterUrl: 'https://example.test/p.jpg' }, 'hand_picked'],
		[{ selectedBackgroundUrl: 'https://example.test/b.jpg' }, 'hand_picked'],
		[{ hasChildSelections: true }, 'hand_picked'],
		[{ externalArtworkChangedAt: new Date(0) }, 'changed_outside_posterpilot']
	] as const)('skips %o as %s', (change, reason) => {
		expect(autoApplySkipReason({ ...fresh, ...change })).toBe(reason);
	});
});
