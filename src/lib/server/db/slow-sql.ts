import type { Client, InArgs, InStatement, ResultSet, TransactionMode } from '@libsql/client';

/**
 * TEMPORARY diagnostic (diag/memory branch only — not for upstream): logs any statement that
 * takes longer than `thresholdMs`, with its duration, row count and the start of its SQL.
 * libsql runs statements on the event-loop thread, so a slow statement is a server stall.
 */

function sqlOf(stmt: InStatement): string {
	return (typeof stmt === 'string' ? stmt : stmt.sql).replace(/\s+/g, ' ').slice(0, 300);
}

function report(
	kind: string,
	sql: string,
	started: number,
	rows: number | null,
	thresholdMs: number
) {
	const ms = Math.round(performance.now() - started);
	if (ms < thresholdMs) return;
	console.warn(`[slow-sql] ${ms}ms ${kind}${rows === null ? '' : ` rows=${rows}`} :: ${sql}`);
}

export function withSlowSqlLog(client: Client, thresholdMs = 500): Client {
	return {
		execute: async (stmtOrSql: InStatement, args?: InArgs): Promise<ResultSet> => {
			const started = performance.now();
			const result =
				typeof stmtOrSql === 'string'
					? await client.execute(stmtOrSql, args)
					: await client.execute(stmtOrSql);
			report('execute', sqlOf(stmtOrSql), started, result.rows.length, thresholdMs);
			return result;
		},
		batch: async (stmts: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode) => {
			const started = performance.now();
			const results = await client.batch(stmts, mode);
			const first = stmts[0];
			const sql = first === undefined ? '' : Array.isArray(first) ? first[0] : sqlOf(first);
			report(`batch(${stmts.length})`, sql, started, null, thresholdMs);
			return results;
		},
		migrate: (stmts: Array<InStatement>) => client.migrate(stmts),
		transaction: async (mode?: TransactionMode) => {
			const tx = await client.transaction(mode);
			return {
				execute: async (stmt: InStatement) => {
					const started = performance.now();
					const result = await tx.execute(stmt);
					report('tx.execute', sqlOf(stmt), started, result.rows.length, thresholdMs);
					return result;
				},
				batch: (stmts: Array<InStatement>) => tx.batch(stmts),
				executeMultiple: (sql: string) => tx.executeMultiple(sql),
				rollback: () => tx.rollback(),
				commit: async () => {
					const started = performance.now();
					await tx.commit();
					report('tx.commit', 'COMMIT', started, null, thresholdMs);
				},
				close: () => tx.close(),
				get closed() {
					return tx.closed;
				}
			};
		},
		executeMultiple: (sql: string) => client.executeMultiple(sql),
		sync: () => client.sync(),
		close: () => client.close(),
		reconnect: () => client.reconnect(),
		get closed() {
			return client.closed;
		},
		get protocol() {
			return client.protocol;
		}
	};
}
