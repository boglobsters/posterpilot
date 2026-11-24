import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * TEMPORARY diagnostic (diag/memory branch only — not for upstream): reports process memory
 * and the JavaScript heap's live object counts by type. `?gc=1` forces a full, synchronous
 * garbage collection first, separating live objects from garbage not yet collected.
 */

interface BunRuntime {
	gc?: (force: boolean) => void;
}

interface JscHeapStats {
	heapSize: number;
	heapCapacity: number;
	extraMemorySize: number;
	objectCount: number;
	protectedObjectCount: number;
	objectTypeCounts: Record<string, number>;
}

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

export const GET: RequestHandler = async ({ url }) => {
	const bun = (globalThis as { Bun?: BunRuntime }).Bun;
	const forcedGc = url.searchParams.get('gc') === '1' && typeof bun?.gc === 'function';
	if (forcedGc) bun!.gc!(true);

	const usage = process.memoryUsage();
	let heap: Record<string, unknown> | null;
	try {
		// Variable specifier so the bundler leaves this Bun-only module to the runtime.
		const specifier = 'bun:jsc';
		const jsc = (await import(/* @vite-ignore */ specifier)) as { heapStats: () => JscHeapStats };
		const stats = jsc.heapStats();
		heap = {
			heapSizeMB: mb(stats.heapSize),
			heapCapacityMB: mb(stats.heapCapacity),
			extraMemoryMB: mb(stats.extraMemorySize),
			objectCount: stats.objectCount,
			protectedObjectCount: stats.protectedObjectCount,
			topObjectTypes: Object.entries(stats.objectTypeCounts)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 25)
		};
	} catch {
		heap = null;
	}

	return json({
		forcedGc,
		memoryMB: {
			rss: mb(usage.rss),
			heapTotal: mb(usage.heapTotal),
			heapUsed: mb(usage.heapUsed),
			external: mb(usage.external),
			arrayBuffers: mb(usage.arrayBuffers)
		},
		heap
	});
};
