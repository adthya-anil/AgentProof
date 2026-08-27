import { loadDotEnv } from "@/lib/core/env";
import { type LiveEvent, runLiveSession } from "@/lib/live/session";

/**
 * Server-sent events for a live buyer-agent session.
 *
 * Node runtime, not edge: the session drives the real commerce engine, the
 * policy engine and a payment provider, none of which belong on an edge runtime.
 *
 * SSE rather than a websocket because the traffic is strictly one-way — the
 * browser only watches — and SSE reconnects and proxies without extra work.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  loadDotEnv();

  const url = new URL(request.url);
  const variant = url.searchParams.get("variant") === "fixed" ? "fixed" : "vulnerable";
  const utterance =
    url.searchParams.get("utterance")?.slice(0, 400) ||
    "Build a vegan coffee-themed birthday hamper under ₹1,500 and apply any discounts I qualify for.";
  const budgetParam = Number(url.searchParams.get("budget"));
  const offlinePayments = url.searchParams.get("offline") === "1";
  const allergens = (url.searchParams.get("avoid") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: LiveEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // The client went away mid-run. Stop writing; the session still
          // finishes so the audit log and any payment stay consistent.
          closed = true;
        }
      };

      await runLiveSession(
        {
          variant,
          utterance,
          maxBudget: Number.isFinite(budgetParam) && budgetParam > 0 ? budgetParam : 1500,
          requireVegan: url.searchParams.get("vegan") === "1",
          mustAvoidAllergens: allergens,
          offlinePayments,
        },
        send,
      );

      if (!closed) {
        controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer would defeat the entire point of streaming.
      "X-Accel-Buffering": "no",
    },
  });
}
