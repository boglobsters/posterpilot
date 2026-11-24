/**
 * TEMPORARY diagnostic (diag/profile branch only — not for upstream).
 *
 * Runs JavaScriptCore's sampling profiler for the life of the process and measures
 * event-loop lag. Every minute the collected stack traces are drained; when the loop
 * stalled for more than STALL_MS in that minute they are written to
 * <data dir>/profiles/<timestamp>.txt, otherwise discarded. Nothing here needs an
 * HTTP request, so it captures a frozen UI too.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TICK_MS = 250;
const STALL_MS = 1000;
const WINDOW_MS = 60_000;

interface Jsc {
	startSamplingProfiler: (directory?: string) => void;
	samplingProfilerStackTraces: () => string;
}

export async function startStallProfiler(dataDirectory: string): Promise<void> {
	let jsc: Jsc;
	try {
		const specifier = 'bun:jsc';
		jsc = (await import(/* @vite-ignore */ specifier)) as Jsc;
		jsc.startSamplingProfiler();
	} catch (error) {
		console.log(`[diag-profile] sampling profiler unavailable: ${String(error)}`);
		return;
	}
	const directory = join(dataDirectory, 'profiles');
	mkdirSync(directory, { recursive: true });
	console.log(`[diag-profile] sampling; stall profiles go to ${directory}`);

	let last = performance.now();
	let worstLag = 0;
	let stalledMs = 0;
	const lagTimer = setInterval(() => {
		const nowMs = performance.now();
		const lag = nowMs - last - TICK_MS;
		last = nowMs;
		if (lag > worstLag) worstLag = lag;
		if (lag > STALL_MS) {
			stalledMs += lag;
			console.log(`[diag-profile] event loop stalled ${Math.round(lag)}ms`);
		}
	}, TICK_MS);
	lagTimer.unref();

	const dumpTimer = setInterval(() => {
		let traces: string;
		try {
			traces = jsc.samplingProfilerStackTraces();
		} catch (error) {
			console.log(`[diag-profile] drain failed: ${String(error)}`);
			return;
		}
		if (stalledMs > 0) {
			const file = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
			writeFileSync(
				file,
				`stalled=${Math.round(stalledMs)}ms worstLag=${Math.round(worstLag)}ms\n${traces}`
			);
			console.log(
				`[diag-profile] wrote ${file} (stalled ${Math.round(stalledMs)}ms, ${traces.length} chars)`
			);
		}
		stalledMs = 0;
		worstLag = 0;
	}, WINDOW_MS);
	dumpTimer.unref();
}
