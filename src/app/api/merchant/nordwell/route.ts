import { type NextRequest, NextResponse } from "next/server";
import {
  handleNordwellRequest,
  nordwellMethodNotAllowed,
} from "@/lib/merchants/nordwellService";

/**
 * Nordwell Provisions, served in-process.
 *
 * The protocol itself lives in `nordwellService`, because the same merchant is also served as
 * a standalone deployment on its own host. Two servers, one implementation: a deployed
 * merchant that had drifted from the one the tests exercise would be worse than no deployment
 * at all, since the demo and the evidence would no longer be about the same shop.
 *
 * This route stays because it is the hermetic default — a demonstration should not depend on
 * someone else's uptime at the moment someone is watching.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const raw = await request.text();
  const reply = handleNordwellRequest(raw);
  return NextResponse.json(reply.body, { status: reply.status });
}

export async function GET(): Promise<NextResponse> {
  const reply = nordwellMethodNotAllowed();
  return NextResponse.json(reply.body, { status: reply.status });
}
