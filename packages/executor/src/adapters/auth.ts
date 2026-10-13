/**
 * Auth adapters: how ibh piggybacks on the host's existing authenticated session.
 * The manifest declares WHAT can be called; the auth adapter declares HOW calls
 * become authenticated. ibh never parses, stores or transmits credentials itself.
 */

export type AuthAdapter =
  /** Use the browser's cookie jar (session cookies, httpOnly, SameSite…). */
  | { mode: 'cookie' }
  /** Ask the host for a bearer token at call time (e.g. Clerk/JWT/…). */
  | { mode: 'token'; getToken: () => Promise<string> }
  /** Host fully controls request init (custom headers, signatures, etc). */
  | { mode: 'custom'; applyAuth: (init: RequestInit, url: string) => RequestInit | Promise<RequestInit> };

export interface ApiResult {
  status: number;
  ok: boolean;
  body: unknown;
}

export interface ApiRequestArgs {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface ApiFetcher {
  request(args: ApiRequestArgs): Promise<ApiResult>;
}
