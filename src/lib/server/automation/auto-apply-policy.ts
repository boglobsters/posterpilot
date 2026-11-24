/**
 * Fork-only (boglobsters/posterpilot): which items an automation may apply artwork to
 * without review. Deliberately conservative — anything a person has looked at, chosen,
 * or changed elsewhere is left alone, so a nightly run never overwrites curation.
 */
export interface AutoApplyCandidateState {
	/** Discovery found at least one candidate for the item. */
	hasCandidates: boolean;
	/** The item was marked reviewed in the review inbox. */
	reviewedAt: Date | null;
	/** Artwork was observed changing outside PosterPilot (e.g. set by hand in Plex). */
	externalArtworkChangedAt: Date | null;
	/** A poster or background was hand-picked but not necessarily applied. */
	selectedPosterUrl: string | null;
	selectedBackgroundUrl: string | null;
	/** Any season/episode/title-card artwork was hand-picked. */
	hasChildSelections: boolean;
	/** PosterPilot has applied artwork to this item successfully at least once. */
	hasSuccessfulApply: boolean;
}

export type AutoApplySkipReason =
	'no_candidates' | 'reviewed' | 'changed_outside_posterpilot' | 'hand_picked' | 'already_applied';

export function autoApplySkipReason(state: AutoApplyCandidateState): AutoApplySkipReason | null {
	if (!state.hasCandidates) return 'no_candidates';
	if (state.hasSuccessfulApply) return 'already_applied';
	if (state.reviewedAt) return 'reviewed';
	if (state.selectedPosterUrl || state.selectedBackgroundUrl || state.hasChildSelections) {
		return 'hand_picked';
	}
	if (state.externalArtworkChangedAt) return 'changed_outside_posterpilot';
	return null;
}
