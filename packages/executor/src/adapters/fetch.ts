import type { ApiFetcher, ApiRequestArgs, ApiResult, AuthAdapter } from './auth';

/**
 * Executes API calls using the host's existing authenticated session.
 * ibh never sees or stores credentials: cookie mode relies on the browser's own
 * cookie jar; token mode asks the host for a token at call time.
 */
export class FetchAdapter implements ApiFetcher {
  constructor(
    private readonly opts: { siteOrigin: string; auth: AuthAdapter }
  ) {}

  async request(args: ApiRequestArgs): Promise<ApiResult> {
    const url = new URL(args.path, this.opts.siteOrigin);
    if (url.origin !== this.opts.siteOrigin) {
      throw new Error(`blocked: cross-origin API call to ${url.origin}`);
    }
    for (const [k, v] of Object.entries(args.query ?? {})) {
      url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }

    let init: RequestInit = {
      method: args.method,
      credentials: 'include',
      headers: { Accept: 'application/json' },
    };
    if (args.body !== undefined) {
      init.body = JSON.stringify(args.body);
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    }

    const { auth } = this.opts;
    if (auth.mode === 'cookie') {
      /* credentials: include already set */
    } else if (auth.mode === 'token') {
      const token = (await auth.getToken()).trim();
      if (token) init.headers = { ...init.headers, Authorization: `Bearer ${token}` };
    } else {
      init = await auth.applyAuth(init, url.toString());
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), init);
    } catch (e) {
      throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }

    let body: unknown = null;
    const contentType = res.headers.get('content-type') ?? '';
    try {
      if (contentType.includes('json')) body = await res.json();
      else if (res.status !== 204) body = await res.text();
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  }
}

/**
 * Interpolate ":param" segments into a path/route template.
 * Pure so it can be unit-tested without a DOM.
 */
export function interpolatePath(template: string, params: Record<string, string> | undefined): string {
  let out = template;
  out = out.replaceAll(/(^|\/):([_a-zA-Z][_a-zA-Z0-9]*)/gu, (_m, slash: string, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === '') {
      throw new ParamError(`missing path parameter "${name}"`);
    }
    return `${slash}${encodeURIComponent(v)}`;
  });
  if (/(^|\/):/u.test(out)) {
    throw new ParamError('path template still contains a parameter placeholder after interpolation');
  }
  return out;
}

export class ParamError extends Error {}

export function tryInterpolatePath(
  template: string,
  params: Record<string, string> | undefined
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    return { ok: true, path: interpolatePath(template, params) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
