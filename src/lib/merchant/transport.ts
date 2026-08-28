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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
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

/** Builds the transport a mapping asks for. */
export function transportFor(
  schema: MerchantSchema,
  fetcher?: Fetcher,
): CatalogTransport {
  return schema.transport.kind === "rest"
    ? new RestTransport(schema.transport, schema.product.id, fetcher)
    : new GraphQLTransport(schema.transport, schema.product.id, fetcher);
}
