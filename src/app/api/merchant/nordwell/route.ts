import { type NextRequest, NextResponse } from "next/server";
import {
  nordwellProducts,
  resetNordwell,
  setNordwellPrice,
  setNordwellStock,
} from "@/lib/merchants/nordwell";

/**
 * Nordwell Provisions' catalogue API.
 *
 * A real endpoint, speaking real GraphQL over real HTTP, so the adapter is exercised the
 * way a third party's merchant would exercise it rather than through a test double
 * written by the same hand at the same time from the same assumptions.
 *
 * Deliberately minimal but honest about the protocol, because the protocol details are
 * what the transport has to survive:
 *
 *  - A failure is reported as `errors` alongside HTTP 200, which is how GraphQL actually
 *    signals problems. A transport checking only the status code would map the partial
 *    `data` and report whatever survived as the catalogue.
 *  - Results come back in the server's order, not the order asked for, and unknown ids
 *    are simply absent. Both are normal and both break a client that zips by position.
 *  - Only the fields the query selects are returned, which is the point of GraphQL and
 *    the reason a mapping cannot assume a field is present just because the schema has
 *    one.
 *
 * Not a full GraphQL implementation: the query is matched rather than parsed. A parser
 * here would be a second project, and would test the parser rather than the adapter.
 */

interface GraphQLRequest {
  query?: unknown;
  variables?: {
    ids?: unknown;
    id?: unknown;
    amount?: unknown;
    quantity?: unknown;
  };
}

function errors(message: string, status = 200): NextResponse {
  // GraphQL convention: a 200 carrying an errors array. Status 400 only for a request
  // that is not GraphQL at all.
  return NextResponse.json({ errors: [{ message }] }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: GraphQLRequest;
  try {
    body = (await request.json()) as GraphQLRequest;
  } catch {
    return errors("request body is not JSON", 400);
  }

  if (typeof body.query !== "string" || body.query.trim() === "") {
    return errors("no query supplied", 400);
  }

  /**
   * The merchant's own admin mutations.
   *
   * A merchant changes its prices; this is how. Needed because the catalogue is served
   * by this process while a demo or test runs in another, so mutating a module-level map
   * in the caller changes nothing here — the first version of the second-merchant demo
   * did exactly that, re-priced its own memory, and reported that a price move went
   * undetected when in fact no price had moved.
   */
  if (/\bsetPrice\s*\(/.test(body.query)) {
    const id = body.variables?.id;
    const amount = body.variables?.amount;
    if (typeof id !== "string" || typeof amount !== "string") {
      return errors("setPrice requires $id: ID! and $amount: String!");
    }
    setNordwellPrice(id, amount);
    return NextResponse.json({ data: { setPrice: { id, amount } } });
  }

  if (/\bsetStock\s*\(/.test(body.query)) {
    const id = body.variables?.id;
    const quantity = body.variables?.quantity;
    if (typeof id !== "string" || typeof quantity !== "number") {
      return errors("setStock requires $id: ID! and $quantity: Int!");
    }
    setNordwellStock(id, quantity);
    return NextResponse.json({ data: { setStock: { id, quantity } } });
  }

  // No argument list, so no parenthesis to match on.
  if (/\bresetCatalogue\b/.test(body.query)) {
    resetNordwell();
    return NextResponse.json({ data: { resetCatalogue: true } });
  }

  // The one query this service offers. Anything else is a schema error, which is what a
  // real server would say rather than returning an empty list.
  if (!/\bproducts\s*\(/.test(body.query)) {
    return errors("Cannot query field other than 'products' on type 'Query'");
  }

  const rawIds = body.variables?.ids;
  if (!Array.isArray(rawIds)) {
    return errors("Variable '$ids' of required type '[ID!]!' was not provided");
  }
  const ids = rawIds.filter((id): id is string => typeof id === "string");

  /**
   * Returned in the service's own order, not the caller's.
   *
   * Reversed on purpose. A merchant is under no obligation to preserve request order,
   * and a client that zips results to requested ids by index would attribute one
   * product's price to another — a wrong price delivered with complete confidence. This
   * makes that bug fail immediately instead of in production.
   */
  const products = nordwellProducts(ids).reverse();

  return NextResponse.json({ data: { products } });
}

/** GraphQL is POST-only here; a GET is a mistake worth naming. */
export async function GET(): Promise<NextResponse> {
  return errors("This endpoint accepts POST with a GraphQL query", 405);
}
