declare module "@duckdb/node-bindings" {
  export function open(...args: unknown[]): Promise<unknown>;
  export function connect(database: unknown, ...args: unknown[]): Promise<unknown>;
  export function query(connection: unknown, query: string, ...args: unknown[]): Promise<unknown>;
  export function appender_create(
    connection: unknown,
    schema: string | null,
    table: string,
  ): unknown;
  export function append_varchar(appender: unknown, value: string): void;
  export function append_double(appender: unknown, value: number): void;
  export function append_null(appender: unknown): void;
  export function append_value(appender: unknown, value: unknown): void;
  export function appender_end_row(appender: unknown): void;
  export function appender_flush_sync(appender: unknown): void;
  export function appender_close_sync(appender: unknown): void;
  export function disconnect_sync(connection: unknown): void;
  export function close_sync(database: unknown): void;
  export function create_varchar(value: string): unknown;
}
