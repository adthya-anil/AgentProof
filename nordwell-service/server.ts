import { createServer } from "node:http";
import {
  handleNordwellRequest,
  nordwellMethodNotAllowed,
} from "../src/lib/merchants/nordwellService.js";

/**
 * Nordwell Provisions as its own service, on its own host.
 *
 * AgentProof's claim is that the merchant under test is an input rather than anything the
 * engine knows about. That is true of the code — the mapping is inferred from one response and
 * no product id appears anywhere in the flow — but while this catalogue was served from
 * AgentProof's own origin, nobody had to take the claim on anything but faith. Running it
 * somewhere else costs one file and removes the objection instead of arguing with it.
 *
 * The behaviour is not reimplemented here. Both this and the in-process route call
 * `handleNordwellRequest`, so a deployed merchant cannot drift from the one the test suite
 * exercises — which would leave the demo and the evidence describing different shops.
 *
 * **This must run as one long-lived process.** The catalogue is in memory and the perturbation
 * faults write to it: `setPrice` moves a price so `INV-PRICE-BINDING` has something to catch.
 * On a host that starts a fresh instance per request — serverless functions, edge workers —
 * those writes land in memory nobody reads again, and the price-drift journey comes back
 * reporting that this merchant's prices cannot be moved. The engine would be right and the
 * deployment would be wrong, which is the hardest kind of failure to spot. Use a container
 * that stays up.
 */

const port = Number(process.env.PORT ?? 8787);

const server = createServer((request, response) => {
  /**
   * Permissive CORS, deliberately.
   *
   * This is a fake shop whose entire purpose is to be called by someone else's tool from
   * somewhere else. A third party's real catalogue would make its own decision here, and that
   * decision is not something this demonstration should pretend to model.
   */
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  /**
   * A plain-text liveness check, separate from the GraphQL endpoint.
   *
   * Hosts poll something to decide whether a deployment came up, and pointing a health check
   * at a POST-only GraphQL endpoint gets a 405 read as "unhealthy" — a service that works
   * perfectly and never goes live.
   */
  if (request.method === "GET" && request.url === "/health") {
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("nordwell provisions: ok");
    return;
  }

  const send = (status: number, body: unknown) => {
    response
      .writeHead(status, { "content-type": "application/json; charset=utf-8" })
      .end(JSON.stringify(body));
  };

  if (request.method !== "POST") {
    const reply = nordwellMethodNotAllowed();
    send(reply.status, reply.body);
    return;
  }

  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const reply = handleNordwellRequest(Buffer.concat(chunks).toString("utf8"));
    send(reply.status, reply.body);
  });
  request.on("error", () => {
    send(400, { errors: [{ message: "the request could not be read" }] });
  });
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `Nordwell Provisions listening on :${port} — POST / with a GraphQL query, GET /health for liveness`,
  );
});
