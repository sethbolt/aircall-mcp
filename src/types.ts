export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type Query = Record<string, QueryValue | undefined>;

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface AircallApi {
  get<T = unknown>(path: string, query?: Query, options?: RequestOptions): Promise<T>;
}

export interface JsonObject {
  [key: string]: unknown;
}
