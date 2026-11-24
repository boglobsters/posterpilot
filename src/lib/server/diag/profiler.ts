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
	samplingProfilerStackTraces: () => unknown;
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
			const raw = jsc.samplingProfilerStackTraces();
			traces = summarize(typeof raw === 'string' ? JSON.parse(raw) : raw);
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

type Frame = Record<string, unknown>;

function frameName(frame: Frame): string {
	const name = String(frame.name ?? frame.functionName ?? '?') || '(anonymous)';
	const where = frame.location ?? frame.sourceURL ?? frame.url ?? '';
	const line = frame.lineNumber ?? frame.line ?? '';
	return `${name} ${String(where).split('/').slice(-2).join('/')}${line === '' ? '' : `:${line}`}`;
}

/** Aggregate JSC's sampled stacks into leaf, self+callers, and inclusive counts. */
function summarize(raw: unknown): string {
	const root = raw as Record<string, unknown>;
	const traces = (Array.isArray(raw) ? raw : (root?.traces ?? root?.stackTraces ?? [])) as Array<
		Record<string, unknown>
	>;
	const leaf = new Map<string, number>();
	const stack = new Map<string, number>();
	const inclusive = new Map<string, number>();
	const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
	for (const trace of traces) {
		const frames = (trace.frames ?? trace.stackFrames ?? trace) as Frame[];
		if (!Array.isArray(frames) || !frames.length) continue;
		const names = frames.map(frameName);
		bump(leaf, names[0]);
		bump(stack, names.slice(0, 10).join('\n    <- '));
		for (const name of new Set(names)) bump(inclusive, name);
	}
	const top = (map: Map<string, number>, n: number) =>
		[...map.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([key, count]) => `${count}\t${key}`)
			.join('\n');
	const sample = JSON.stringify(traces[0] ?? null).slice(0, 1500);
	return [
		`keys=${JSON.stringify(Object.keys(root ?? {}))} samples=${traces.length}`,
		`first sample: ${sample}`,
		'=== leaf frames ===',
		top(leaf, 40),
		'=== inclusive ===',
		top(inclusive, 60),
		'=== top stacks ===',
		top(stack, 25)
	].join('\n');
}
