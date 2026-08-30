import type { CatalogTransport } from "./adapter.js";
import { type MerchantSchema, readPath } from "./mapping.js";

/**
 * How a product gets off the wire.
 *
 * Split from the mapping because they fail differently and should be diagnosable
 * separately: a 404 means the merchant does not have that id, a mapping error means the
 * response arrived and this configuration does not describe it. Collapsing the two
 * would produce "could not read product" for both, which is the least useful possible
 * message.
 */

/** Injectable so tests need no network and no mock server. */
export type Fetcher = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * How long a third party gets to answer.
 *
 * There was no timeout at all, which is survivable against a merchant running in this
 * process and indefensible against one that is not. A hung connection stalled a run until
 * the route's own 30-minute ceiling: the page sat there, the suite produced nothing, and
 * the only signal a user got was that the product appeared broken.
 *
 * Ten seconds is generous for a catalogue read and short enough that a dead endpoint is
 * diagnosed rather than waited on. Overridable because a slow staging merchant is a real
 * thing and not a reason to be untestable.
 */
export const DEFAULT_MERCHANT_TIMEOUT_MS = 10_000;

export function merchantTimeoutMs(): number {
  const raw = Number(process.env.MERCHANT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MERCHANT_TIMEOUT_MS;
  return Math.trunc(raw);
}

/**
 * Bounds a fetcher in time and gives every network failure one recognisable type.
 *
 * Wrapped at this single seam rather than at each call site, because there are nine of
 * them across two transports and a tenth would eventually be added without a timeout.
 *
 * The conversion matters as much as the timeout. A refused connection, an unresolvable
 * host, a TLS failure and an abort all arrive here as unrelated exception shapes, and
 * anything the runner cannot recognise as a *merchant* failure it treats as a bug in the
 * harness — which reports the run `NOT READY`, an accusation about the integration's
 * safety drawn from our own inability to open a socket. Naming them all `TransportError`
 * is what lets that verdict be `INCONCLUSIVE` instead.
 */
export function withTimeout(fetcher: Fetcher, timeoutMs: number): Fetcher {
  return async (url, init) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Raced, not merely signalled.
     *
     * Passing an `AbortSignal` is a request, and it only bounds anything if the fetcher
     * honours it. Real `fetch` does; a wrapper that retries internally, or any fetcher that
     * ignores the signal, does not — and the first version of this deadlocked against one,
     * which is how a bound that exists only on paper gets discovered.
     */
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new TransportError(
            `the merchant did not respond within ${timeoutMs}ms`,
            null,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        fetcher(url, { ...init, signal: controller.signal }),
        expiry,
      ]);
    } catch (error) {
      // Already diagnosed, more precisely than this layer could manage.
      if (error instanceof TransportError) throw error;

      if (isNetworkFailure(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new TransportError(
          `the merchant could not be reached: ${detail}`,
          null,
        );
      }

      /**
       * Anything unrecognised is left exactly as it was.
       *
       * Converting every exception here would have relabelled a bug in our own code as the
       * merchant being down — which routes it to `INCONCLUSIVE` and stops the run failing.
       * "Inconclusive" must not become the place crashes go to hide, so the conversion is
       * deliberately limited to failures that are recognisably the network's.
       */
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Codes and shapes the runtime raises when the other end is simply not there.
 *
 * Matched on `code` rather than message text, because these come from undici and the TLS
 * stack with wording that changes between Node versions.
 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPROTO",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
]);

/**
 * Whether a failure is the network's rather than ours.
 *
 * Lives here so the transport and the runner cannot disagree about it: the runner turns this
 * answer into `INCONCLUSIVE` instead of `NOT READY`, and two copies of the rule would
 * eventually drift into a verdict that depended on which layer noticed first.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TransportError) return true;
  if (!(error instanceof Error)) return false;

  // `AbortSignal.timeout` raises TimeoutError; an aborted controller raises AbortError.
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;

  // undici reports this bare message on the outer error and hides the detail in `cause`.
  if (error.message.includes("fetch failed")) return true;

  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined || cause === null ? false : isNetworkFailure(cause);
}

/**
 * REST, preferring a batch endpoint when the merchant offers one.
 *
 * Without batching, a six-line quote evaluated at five checkpoints is thirty product
 * reads. Sequential, that is thirty round trips inside what used to be an instantaneous
 * map lookup, and a preflight suite of thirty journeys turns a two-second run into
 * minutes. So: one request when the merchant has a batch endpoint, and concurrent
 * requests when it does not — never a sequential loop.
 *
 * A single missing product is not an error. A merchant legitimately delists things, and
 * the invariants already treat an unresolvable product as a finding of their own
 * (`unknown_product`, "no longer in the catalog"). Turning it into a transport failure
 * here would replace a precise verdict with a crash.
 */
export class RestTransport implements CatalogTransport {
  readonly kind = "rest";

  constructor(
    private readonly schema: Extract<
      MerchantSchema["transport"],
      { kind: "rest" }
    >,
    /**
     * Where a row's own id lives, taken from the product mapping.
     *
     * The transport needs this to match batch results back to the ids requested. It
     * cannot assume `id`: a merchant that calls it `sku` or `product_id` would match
     * nothing, every row would be discarded, and the snapshot would come back
     * empty — which reads as "the merchant has none of these products" rather than
     * as a configuration error.
     */
    private readonly idPath: string,
    private readonly fetcher: Fetcher = globalThis.fetch as Fetcher,
  ) {}

  async fetch(ids: readonly string[]): Promise<Map<string, unknown>> {
    return this.schema.batch ? this.fetchBatch(ids) : this.fetchEach(ids);
  }

  /** Reads a listing endpoint, when the mapping declares one. */
  async list(path: string, root?: string): Promise<unknown[]> {
    const url = new URL(path, this.schema.baseUrl);
    const response = await this.fetcher(url.toString(), {
      method: "GET",
      headers: this.schema.headers,
    });
    if (!response.ok) {
      throw new TransportError(
        `catalogue listing failed with ${response.status}`,
        response.status,
      );
    }
    const body = await response.json();
    const rows = root ? readPath(body, root) : body;
    if (!Array.isArray(rows)) {
      throw new TransportError(
        `catalogue listing has no array at '${root ?? "(root)"}'`,
        response.status,
      );
    }
    return rows;
  }

  private async fetchBatch(ids: readonly string[]): Promise<Map<string, unknown>> {
    const batch = this.schema.batch;
    if (!batch) return this.fetchEach(ids);

    const url = new URL(batch.path, this.schema.baseUrl);
    url.searchParams.set(batch.idsParam, ids.join(","));

    const response = await this.fetcher(url.toString(), {
      method: this.schema.method,
      headers: this.schema.headers,
    });
    if (!response.ok) {
      throw new TransportError(
        `batch product read failed with ${response.status}`,
        response.status,
      );
    }

    const body = await response.json();
    const rows = readPath(body, batch.root);
    if (!Array.isArray(rows)) {
      throw new TransportError(
        `batch response has no array at '${batch.root}'`,
        response.status,
      );
    }

    /**
     * Matched back to the requested ids rather than trusted in order.
     *
     * A batch endpoint is under no obligation to return results in the order asked, or
     * to return one per id. Zipping by index would silently attribute one product's
     * price to another — a wrong price presented with total confidence, which is worse
     * than an error.
     */
    const byId = new Map<string, unknown>();
    for (const row of rows) {
      const id = readPath(row, this.idPath);
      if (typeof id === "string" || typeof id === "number") {
        byId.set(String(id), row);
      }
    }

    const resolved = new Map<string, unknown>();
    for (const id of ids) {
      const row = byId.get(id);
      if (row !== undefined) resolved.set(id, row);
    }
    return resolved;
  }

  private async fetchEach(ids: readonly string[]): Promise<Map<string, unknown>> {
    // Concurrent, not sequential. Awaiting each in a loop is the difference between a
    // suite that runs in seconds and one nobody waits for.
    const settled = await Promise.all(
      ids.map(async (id) => {
        const url = new URL(
          this.schema.productPath.replace("{id}", encodeURIComponent(id)),
          this.schema.baseUrl,
        );
        const response = await this.fetcher(url.toString(), {
          method: this.schema.method,
          headers: this.schema.headers,
        });
        if (response.status === 404) return [id, undefined] as const;
        if (!response.ok) {
          throw new TransportError(
            `product read for '${id}' failed with ${response.status}`,
            response.status,
          );
        }
        const body = await response.json();
        const root = this.schema.root;
        return [id, root ? readPath(body, root) : body] as const;
      }),
    );

    const resolved = new Map<string, unknown>();
    for (const [id, value] of settled) {
      if (value !== undefined) resolved.set(id, value);
    }
    return resolved;
  }
}

/**
 * GraphQL, one round trip per checkpoint.
 *
 * Batching is not an optimisation here, it is the natural shape: the query takes
 * `$ids` and returns a list. The interesting part is that a GraphQL 200 can still be a
 * failure — `errors` populated alongside a partial `data` — and a transport that only
 * checked the HTTP status would map an error response as though it were products and
 * report whatever survived as the catalogue.
 */
export class GraphQLTransport implements CatalogTransport {
  readonly kind = "graphql";

  constructor(
    private readonly schema: Extract<
      MerchantSchema["transport"],
      { kind: "graphql" }
    >,
    /** Where a row's own id lives, from the product mapping. Never assumed. */
    private readonly idPath: string,
    private readonly fetcher: Fetcher = globalThis.fetch as Fetcher,
  ) {}

  /** Runs a write against the merchant, when the mapping declares one. */
  async mutate(operation: string, variables: Record<string, unknown>): Promise<void> {
    const response = await this.fetcher(this.schema.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.schema.headers },
      body: JSON.stringify({ query: operation, variables }),
    });
    if (!response.ok) {
      throw new TransportError(
        `merchant write failed with ${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { errors?: Array<{ message?: string }> };
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new TransportError(
        `graphql errors: ${body.errors.map((e) => e.message ?? "unknown").join("; ")}`,
        response.status,
      );
    }
  }

  /** Runs a listing operation, when the mapping declares one. */
  async list(query: string, root?: string): Promise<unknown[]> {
    const response = await this.fetcher(this.schema.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.schema.headers },
      body: JSON.stringify({ query, variables: {} }),
    });
    if (!response.ok) {
      throw new TransportError(
        `catalogue listing failed with ${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as {
      data?: unknown;
      errors?: Array<{ message?: string }>;
    };
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new TransportError(
        `graphql errors: ${body.errors.map((e) => e.message ?? "unknown").join("; ")}`,
        response.status,
      );
    }
    const rows = readPath(body.data, root ?? this.schema.root);
    if (!Array.isArray(rows)) {
      throw new TransportError(
        `catalogue listing has no array at data.${root ?? this.schema.root}`,
        response.status,
      );
    }
    return rows;
  }

  async fetch(ids: readonly string[]): Promise<Map<string, unknown>> {
    const response = await this.fetcher(this.schema.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.schema.headers },
      body: JSON.stringify({
        query: this.schema.query,
        variables: { ids: [...ids] },
      }),
    });

    if (!response.ok) {
      throw new TransportError(
        `graphql request failed with ${response.status}`,
        response.status,
      );
    }

    const body = (await response.json()) as {
      data?: unknown;
      errors?: Array<{ message?: string }>;
    };

    // A 200 with errors is the normal way GraphQL reports failure.
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const detail = body.errors
        .map((e) => e.message ?? "unknown error")
        .join("; ");
      throw new TransportError(`graphql errors: ${detail}`, response.status);
    }

    const rows = readPath(body.data, this.schema.root);
    if (!Array.isArray(rows)) {
      throw new TransportError(
        `graphql response has no array at data.${this.schema.root}`,
        response.status,
      );
    }

    const byId = new Map<string, unknown>();
    for (const row of rows) {
      const id = readPath(row, this.idPath);
      if (typeof id === "string" || typeof id === "number") {
        byId.set(String(id), row);
      }
    }

    const resolved = new Map<string, unknown>();
    for (const id of ids) {
      const row = byId.get(id);
      if (row !== undefined) resolved.set(id, row);
    }
    return resolved;
  }
}

/**
 * Builds the transport a mapping asks for, always bounded in time.
 *
 * The timeout is applied here rather than left to callers, so no transport can be
 * constructed without one. Injected fetchers are wrapped too: a test double resolves
 * instantly and is unaffected, while a script or route that passes its own fetcher still
 * cannot accidentally opt out of the bound.
 */
export function transportFor(
  schema: MerchantSchema,
  fetcher?: Fetcher,
  timeoutMs: number = merchantTimeoutMs(),
): CatalogTransport {
  const bounded = withTimeout(
    fetcher ?? (globalThis.fetch as Fetcher),
    timeoutMs,
  );
  return schema.transport.kind === "rest"
    ? new RestTransport(schema.transport, schema.product.id, bounded)
    : new GraphQLTransport(schema.transport, schema.product.id, bounded);
}
