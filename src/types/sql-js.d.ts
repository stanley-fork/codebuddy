export interface SqlJsStatement {
  bind(params: (string | number | null | Uint8Array)[]): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
  reset(): void;
}

export interface SqlJsDatabase {
  run(sql: string, params?: (string | number | null | Uint8Array)[]): void;
  run(
    sql: string,
    params?: Record<string, string | number | null | Uint8Array>,
  ): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): SqlJsStatement;
  close(): void;
}
