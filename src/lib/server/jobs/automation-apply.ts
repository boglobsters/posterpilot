/**
 * Fork-only (boglobsters/posterpilot): the apply step of a `sync_discover_apply`
 * automation. Picks the items nobody has curated (see auto-apply-policy.ts), freezes an
 * automatic-selection apply plan for them exactly like the bulk "Apply" button does, and
 * queues it as its own apply job — so it shows up with its own progress, outcomes and
 * undo history, and runs after the automation job finishes.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { appliedPosters, childSelections, mediaItems } from '$lib/server/db/schema';
import { logEvent } from '$lib/server/events';
import { autoApplySkipReason } from '$lib/server/automation/auto-apply-policy';
import {
	confirmDatabaseArtworkApply,
	previewDatabaseArtworkApply,
	resolveDatabaseApplyTargets
} from '$lib/server/plans/apply-runtime';

const CHUNK = 500;

/** Item ids, among those just discovered, that an automation may apply artwork to. */
export async function selectAutoApplyItemIds(
	serverInstanceId: string,
	itemIds: number[]
): Promise<number[]> {
	const eligible: number[] = [];
	for (let offset = 0; offset < itemIds.length; offset += CHUNK) {
		const ids = itemIds.slice(offset, offset + CHUNK);
		const rows = await db
			.select({
				id: mediaItems.id,
				hasCandidates: mediaItems.hasCandidates,
				reviewedAt: mediaItems.reviewedAt,
				externalArtworkChangedAt: mediaItems.externalArtworkChangedAt,
				selectedPosterUrl: mediaItems.selectedPosterUrl,
				selectedBackgroundUrl: mediaItems.selectedBackgroundUrl
			})
			.from(mediaItems)
			.where(
				and(
					eq(mediaItems.serverInstanceId, serverInstanceId),
					inArray(mediaItems.id, ids),
					eq(mediaItems.ignored, false),
					eq(mediaItems.resolved, true)
				)
			);
		const applied = new Set(
			(
				await db
					.selectDistinct({ id: appliedPosters.mediaItemId })
					.from(appliedPosters)
					.where(
						and(
							eq(appliedPosters.serverInstanceId, serverInstanceId),
							inArray(appliedPosters.mediaItemId, ids),
							eq(appliedPosters.status, 'success')
						)
					)
			).map((row) => row.id)
		);
		const picked = new Set(
			(
				await db
					.selectDistinct({ id: childSelections.mediaItemId })
					.from(childSelections)
					.where(
						and(
							eq(childSelections.serverInstanceId, serverInstanceId),
							inArray(childSelections.mediaItemId, ids)
						)
					)
			).map((row) => row.id)
		);
		for (const row of rows) {
			const reason = autoApplySkipReason({
				...row,
				hasChildSelections: picked.has(row.id),
				hasSuccessfulApply: applied.has(row.id)
			});
			if (reason === null) eligible.push(row.id);
		}
	}
	return eligible.sort((left, right) => left - right);
}

/**
 * Plan and queue the automatic apply. Returns the queued job id, or null when nothing
 * qualified or every eligible item produced no operation (e.g. no usable candidate).
 */
export async function queueAutomationApply(input: {
	serverInstanceId: string;
	itemIds: number[];
	parentJobId: number | null;
}): Promise<number | null> {
	const eligible = await selectAutoApplyItemIds(input.serverInstanceId, input.itemIds);
	if (eligible.length === 0) {
		await logEvent('info', 'automation', 'Automatic apply: nothing new to apply', {
			serverInstanceId: input.serverInstanceId,
			considered: input.itemIds.length
		});
		return null;
	}
	const targets = await resolveDatabaseApplyTargets(eligible, input.serverInstanceId);
	const preview = await previewDatabaseArtworkApply({
		context: { source: 'bulk', resultSetFingerprint: null },
		targets,
		selectionMode: 'auto'
	});
	if (!preview.planId || !preview.digest || preview.summary.operationCount === 0) {
		await logEvent('info', 'automation', 'Automatic apply: no artwork to change', {
			serverInstanceId: input.serverInstanceId,
			eligible: eligible.length
		});
		return null;
	}
	// The runner imports this module's caller, so it is loaded lazily to avoid a cycle.
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
	await logEvent('info', 'automation', 'Automatic apply queued', {
		serverInstanceId: input.serverInstanceId,
		jobId,
		items: preview.summary.itemCount,
		operations: preview.summary.operationCount
	});
	return jobId;
}
