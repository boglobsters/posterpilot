/**
 * Fork-only (boglobsters/posterpilot): fill artwork for seasons and episodes added after a
 * show's set was applied. Part of a `sync_discover_apply` automation.
 *
 * For every show in scope that already has season/episode artwork chosen from a set, it
 * compares that set's current candidates (refreshed by the automation's own discovery)
 * with the slots PosterPilot has already applied, and plans only the missing ones, from
 * that same set. Slots for episodes not in the media server yet are skipped by the planner
 * as unresolved and are picked up by a later run once the episode exists.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	appliedPosters,
	childSelections,
	mediaItems,
	posterCandidates
} from '$lib/server/db/schema';
import { logEvent } from '$lib/server/events';
import {
	chosenSetFor,
	fillSlotKey,
	missingSetSlots,
	type ChosenSlotSelection
} from '$lib/server/automation/episode-fill-policy';
import type {
	AutomaticArtworkSelection,
	AutomaticCandidateSelection
} from '$lib/server/posters/automatic-selection';
import {
	confirmDatabaseArtworkApply,
	previewDatabaseArtworkApply,
	resolveDatabaseApplyTargets
} from '$lib/server/plans/apply-runtime';

const CHUNK = 200;

/** Per show, the chosen set's candidates for the season-level slots never applied. */
export async function planEpisodeFillSelections(
	serverInstanceId: string,
	itemIds: number[]
): Promise<Map<number, AutomaticCandidateSelection[]>> {
	const result = new Map<number, AutomaticCandidateSelection[]>();
	for (let offset = 0; offset < itemIds.length; offset += CHUNK) {
		const ids = itemIds.slice(offset, offset + CHUNK);
		const shows = (
			await db
				.select({ id: mediaItems.id })
				.from(mediaItems)
				.where(
					and(
						eq(mediaItems.serverInstanceId, serverInstanceId),
						inArray(mediaItems.id, ids),
						eq(mediaItems.type, 'show'),
						eq(mediaItems.ignored, false),
						eq(mediaItems.resolved, true)
					)
				)
		).map((row) => row.id);
		if (!shows.length) continue;

		const [selections, applied] = await Promise.all([
			db
				.select({
					mediaItemId: childSelections.mediaItemId,
					kind: childSelections.kind,
					provider: childSelections.provider,
					setId: childSelections.setId
				})
				.from(childSelections)
				.where(
					and(
						eq(childSelections.serverInstanceId, serverInstanceId),
						inArray(childSelections.mediaItemId, shows)
					)
				),
			db
				.select({
					mediaItemId: appliedPosters.mediaItemId,
					candidateId: appliedPosters.candidateId,
					kind: appliedPosters.kind,
					season: appliedPosters.season,
					episode: appliedPosters.episode
				})
				.from(appliedPosters)
				.where(
					and(
						eq(appliedPosters.serverInstanceId, serverInstanceId),
						inArray(appliedPosters.mediaItemId, shows),
						eq(appliedPosters.status, 'success')
					)
				)
		]);
		// Artwork applied without stored selections (e.g. by this automation's own
		// auto-apply) still names its set through the candidate it came from.
		const appliedCandidateIds = [
			...new Set(applied.map((row) => row.candidateId).filter((id): id is number => id !== null))
		];
		const appliedCandidates = new Map<number, { provider: string; setId: string }>();
		for (let index = 0; index < appliedCandidateIds.length; index += 500) {
			for (const row of await db
				.select({
					id: posterCandidates.id,
					provider: posterCandidates.provider,
					setId: posterCandidates.setId
				})
				.from(posterCandidates)
				.where(inArray(posterCandidates.id, appliedCandidateIds.slice(index, index + 500)))) {
				appliedCandidates.set(row.id, row);
			}
		}
		const storedByItem = new Map<number, ChosenSlotSelection[]>();
		for (const row of selections) {
			const list = storedByItem.get(row.mediaItemId) ?? [];
			list.push(row);
			storedByItem.set(row.mediaItemId, list);
		}
		const appliedByItem = new Map<number, ChosenSlotSelection[]>();
		const filledByItem = new Map<number, Set<string>>();
		for (const row of applied) {
			if (!row.kind) continue;
			const keys = filledByItem.get(row.mediaItemId) ?? new Set<string>();
			keys.add(fillSlotKey({ kind: row.kind, season: row.season, episode: row.episode }));
			filledByItem.set(row.mediaItemId, keys);
			const source = row.candidateId === null ? undefined : appliedCandidates.get(row.candidateId);
			if (source && row.season !== null) {
				const list = appliedByItem.get(row.mediaItemId) ?? [];
				list.push({ kind: row.kind, provider: source.provider, setId: source.setId });
				appliedByItem.set(row.mediaItemId, list);
			}
		}
		const withSet = shows
			.map((id) => [id, chosenSetFor(storedByItem.get(id) ?? appliedByItem.get(id) ?? [])] as const)
			.filter((entry): entry is readonly [number, NonNullable<ReturnType<typeof chosenSetFor>>] =>
				Boolean(entry[1])
			);
		if (!withSet.length) continue;
		const candidates = await db
			.select({
				id: posterCandidates.id,
				mediaItemId: posterCandidates.mediaItemId,
				provider: posterCandidates.provider,
				setId: posterCandidates.setId,
				setAuthor: posterCandidates.setAuthor,
				url: posterCandidates.url,
				kind: posterCandidates.kind,
				season: posterCandidates.season,
				episode: posterCandidates.episode,
				width: posterCandidates.width,
				height: posterCandidates.height,
				score: posterCandidates.score
			})
			.from(posterCandidates)
			.where(
				and(
					eq(posterCandidates.serverInstanceId, serverInstanceId),
					inArray(
						posterCandidates.mediaItemId,
						withSet.map(([id]) => id)
					),
					eq(posterCandidates.active, true)
				)
			);
		for (const [itemId, set] of withSet) {
			const setCandidates = candidates.filter(
				(row) =>
					row.mediaItemId === itemId && row.provider === set.provider && row.setId === set.setId
			);
			const missing = missingSetSlots(setCandidates, filledByItem.get(itemId) ?? new Set());
			if (!missing.length) continue;
			result.set(
				itemId,
				missing.map(({ candidate, slot }) => ({
					candidateId: candidate.id,
					url: candidate.url,
					provider: candidate.provider,
					setId: candidate.setId,
					setAuthor: candidate.setAuthor,
					score: candidate.score ?? 0,
					width: candidate.width,
					height: candidate.height,
					slot
				}))
			);
		}
	}
	return result;
}

/** Plan and queue the fill as its own apply job; null when there is nothing to apply. */
export async function queueEpisodeFill(input: {
	serverInstanceId: string;
	itemIds: number[];
	parentJobId: number | null;
}): Promise<number | null> {
	const fills = await planEpisodeFillSelections(input.serverInstanceId, input.itemIds);
	if (fills.size === 0) return null;
	const targets = await resolveDatabaseApplyTargets(
		[...fills.keys()].sort((left, right) => left - right),
		input.serverInstanceId
	);
	const preview = await previewDatabaseArtworkApply(
		{
			context: { source: 'bulk', resultSetFingerprint: null },
			targets,
			selectionMode: 'auto'
		},
		{
			selectAutomatic: async (ref): Promise<AutomaticArtworkSelection> => ({
				poster: null,
				background: null,
				children: fills.get(ref.mediaItemId) ?? []
			})
		}
	);
	if (!preview.planId || !preview.digest || preview.summary.operationCount === 0) {
		// Usually episodes the set has cards for but the server does not have yet.
		return null;
	}
	const { enqueueJobDetailed } = await import('./runner');
	const { jobId } = await confirmDatabaseArtworkApply(
		{
			planId: preview.planId,
			digest: preview.digest,
			serverInstanceId: input.serverInstanceId
		},
		async (payload) =>
			(
				await enqueueJobDetailed(payload, {
					parentJobId: input.parentJobId,
					trigger: 'automation'
				})
			).jobId
	);
	await logEvent('info', 'automation', 'New episode artwork queued', {
		serverInstanceId: input.serverInstanceId,
		jobId,
		shows: preview.summary.itemCount,
		operations: preview.summary.operationCount
	});
	return jobId;
}
