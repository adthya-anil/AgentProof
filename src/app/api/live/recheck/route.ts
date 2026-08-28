import { loadDotEnv } from "@/lib/core/env";
import { recheckPayment } from "@/lib/live/session";

/**
 * Re-verifies a hosted payment after a human has paid it.
 *
 * Separate from the streaming run because it answers a question that only exists
 * once the run is over: the agent creates a payment link and correctly stops,
 * `INV-PAYMENT-STATE` refuses to fulfil an uncaptured payment, and then somebody
 * goes and pays. Without this, that payment changed nothing — nobody ever asked
 * the provider again.
 *
 * Plain JSON rather than SSE: it is two provider calls, not a conversation.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  loadDotEnv();

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    return Response.json(
      { error: "A session id is required." },
      { status: 400 },
    );
  }

  try {
    const result = await recheckPayment(sessionId);
    // A missing session is a real answer, not a server fault: sessions are held
    // for an hour and lost on restart, and the caller needs to be told which.
    return Response.json(result, { status: result.found ? 200 : 410 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
