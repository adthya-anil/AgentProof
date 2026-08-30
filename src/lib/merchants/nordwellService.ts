import {
  nordwellProducts,
  resetNordwell,
  setNordwellPrice,
  setNordwellStock,
} from "./nordwell.js";

/**
 * Nordwell Provisions' catalogue API, as a function of a request body.
 *
 * Extracted from the Next route so the same merchant can be served two ways: in-process at
 * `/api/merchant/nordwell`, and as a standalone service on its own host. Both call this, so
 * there is exactly one implementation of the protocol and no possibility of the deployed
 * merchant drifting from the one the tests exercise.
 *
 * Deliberately minimal but honest about the protocol, because the protocol details are what
 * the transport has to survive:
 *
 *  - A failure is reported as `errors` alongside HTTP 200, which is how GraphQL actually
 *    signals problems. A transport checking only the status code would map the partial
 *    `data` and report whatever survived as the catalogue.
 *  - Results come back in the server's order, not the order asked for, and unknown ids are
 *    simply absent. Both are normal and both break a client that zips by position.
 *
 * Not a full GraphQL implementation: the query is matched rather than parsed. A parser here
 * would be a second project, and would test the parser rather than the adapter.
 */

export interface NordwellReply {
  status: number;
  body: unknown;
}

interface GraphQLRequest {
  query?: unknown;
  variables?: {
    ids?: unknown;
    id?: unknown;
    amount?: unknown;
    quantity?: unknown;
  };
}

/**
 * GraphQL convention: a 200 carrying an `errors` array. Status 400 is reserved for a request
 * that is not GraphQL at all.
 */
function errors(message: string, status = 200): NordwellReply {
  return { status, body: { errors: [{ message }] } };
}

/**
 * Takes the raw request body rather than a parsed object, so that "this is not JSON" is
 * answered identically by every host serving this merchant. Leaving the parse to each caller
 * is how two servers end up disagreeing about a malformed request.
 */
export function handleNordwellRequest(rawBody: string): NordwellReply {
  let body: GraphQLRequest;
  try {
    body = JSON.parse(rawBody) as GraphQLRequest;
  } catch {
    return errors("request body is not JSON", 400);
  }

  if (typeof body.query !== "string" || body.query.trim() === "") {
    return errors("no query supplied", 400);
  }

  /**
   * The merchant's own admin mutations.
   *
   * A merchant changes its prices; this is how. Needed because the catalogue is served by
   * this process while a demo or test runs in another, so mutating a module-level map in the
   * caller changes nothing here — the first version of the second-merchant demo did exactly
   * that, re-priced its own memory, and reported that a price move went undetected when in
   * fact no price had moved.
   *
   * This is also why the standalone service must run as one long-lived process. On a host
   * that starts a fresh instance per request, these writes would land in memory nobody reads
   * again, and the price-drift journey would report that this merchant's prices cannot be
   * moved.
   */
  if (/\bsetPrice\s*\(/.test(body.query)) {
    const id = body.variables?.id;
    const amount = body.variables?.amount;
    if (typeof id !== "string" || typeof amount !== "string") {
      return errors("setPrice requires $id: ID! and $amount: String!");
    }
    setNordwellPrice(id, amount);
    return { status: 200, body: { data: { setPrice: { id, amount } } } };
  }

  if (/\bsetStock\s*\(/.test(body.query)) {
    const id = body.variables?.id;
    const quantity = body.variables?.quantity;
    if (typeof id !== "string" || typeof quantity !== "number") {
      return errors("setStock requires $id: ID! and $quantity: Int!");
    }
    setNordwellStock(id, quantity);
    return { status: 200, body: { data: { setStock: { id, quantity } } } };
  }

  // No argument list, so no parenthesis to match on.
  if (/\bresetCatalogue\b/.test(body.query)) {
    resetNordwell();
    return { status: 200, body: { data: { resetCatalogue: true } } };
  }

  // The one query this service offers, with or without an argument list — `products(ids:)`
  // fetches, bare `products` browses. Matching only the parenthesised form rejected every
  // listing query as an unknown field.
  if (!/\bproducts\b/.test(body.query)) {
    return errors("Cannot query field other than 'products' on type 'Query'");
  }

  /**
   * `products` with no ids lists the catalogue.
   *
   * A browsing operation, distinct from the fetch-by-id path — an agent shopping this store
   * has no ids to ask for until it has looked. Only a query that *declares* `$ids` is
   * required to supply them, so a listing query is not treated as a malformed fetch.
   */
  const declaresIds = /\$ids\b/.test(body.query);
  const rawIds = body.variables?.ids;
  if (declaresIds && !Array.isArray(rawIds)) {
    return errors("Variable '$ids' of required type '[ID!]!' was not provided");
  }
  const ids = Array.isArray(rawIds)
    ? rawIds.filter((id): id is string => typeof id === "string")
    : undefined;

  /**
   * Returned in the service's own order, not the caller's.
   *
   * Reversed on purpose. A merchant is under no obligation to preserve request order, and a
   * client that zips results to requested ids by index would attribute one product's price to
   * another — a wrong price delivered with complete confidence. This makes that bug fail
   * immediately instead of in production.
   */
  // `undefined` means "everything", which is what a listing asks for.
  const products = nordwellProducts(ids).reverse();

  return { status: 200, body: { data: { products } } };
}

/** GraphQL is POST-only here; a GET is a mistake worth naming. */
export function nordwellMethodNotAllowed(): NordwellReply {
  return errors("This endpoint accepts POST with a GraphQL query", 405);
}
