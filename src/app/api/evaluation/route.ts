import { loadDotEnv } from "@/lib/core/env";
import { computeMutationScores } from "@/lib/dashboard/data";
import { MUTATION_IDS } from "@/lib/hamperhub/mutations";

/**
 * Scores every seeded defect in isolation, streaming one result per mutant.
 *
 * Separate from the preflight route because it answers a different question. A
 * preflight run asks "is this integration safe?". This asks "does the Guard
 * actually catch the things it claims to?" — the recall number the whole product
 * rests on. Running it means one full journey per defect, so like every other
 * run it happens when someone asks for it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function GET(): Promise<Response> {
  loadDotEnv();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        send({ kind: "start", total: MUTATION_IDS.length });

        const scores = await computeMutationScores({
          onMutationStart: (mutation, index, total) =>
            send({ kind: "mutation_start", mutation, index, total }),
          onMutationScored: (score, index, total) =>
            send({ kind: "mutation_scored", index, total, ...score }),
        });

        const detected = scores.filter((s) => s.detected).length;
        send({
          kind: "done",
          detected,
          total: scores.length,
          recallPercent: scores.length === 0 ? 0 : (detected / scores.length) * 100,
          escapes: scores.reduce((sum, s) => sum + s.escapes, 0),
        });
      } catch (error) {
        send({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }

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
      "X-Accel-Buffering": "no",
    },
  });
}
