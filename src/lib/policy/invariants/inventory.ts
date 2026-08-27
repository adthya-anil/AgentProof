import { type Invariant, pass, skip, violation } from "./types.js";

/**
 * Everything being sold must still be available, and held, at the moment of
 * checkout.
 *
 * Inventory is re-read live here rather than trusted from the quote snapshot.
 * The version comparison is informational; the decision rests on whether stock
 * can actually satisfy the line right now, because a version bump that restocked
 * an item should not block a sale.
 */
export const inventoryInvariant: Invariant = {
  id: "INV-INVENTORY",
  title: "Every purchased quantity is currently available and reserved",
  severity: "critical",
  policyRefs: [
    "inventory.require_current_availability",
    "inventory.reserve_before_checkout",
  ],
  attribution: "integration",
  appliesAt: ["quote.created", "checkout.requested"],
  evaluate(ctx) {
    if (!ctx.policy.inventory.requireCurrentAvailability) {
      return skip("Availability checks disabled by policy");
    }
    const quote = ctx.quote;
    if (!quote) return skip("No quote to evaluate");

    const reservation = quote.reservationId
      ? ctx.catalog.getReservation(quote.reservationId)
      : undefined;

    // Quantity already held for *this* quote, which is not "free" stock but is
    // legitimately usable by this checkout.
    const heldForThisQuote = new Map<string, number>();
    if (reservation && reservation.status === "held") {
      for (const item of reservation.items) {
        heldForThisQuote.set(
          item.productId,
          (heldForThisQuote.get(item.productId) ?? 0) + item.quantity,
        );
      }
    }

    const shortages: Array<Record<string, unknown>> = [];
    let atRisk = 0;

    for (const line of quote.lineItems) {
      const record = ctx.catalog.getInventory(line.productId);
      if (!record) {
        shortages.push({
          productId: line.productId,
          name: line.name,
          issue: "no_inventory_record",
          requested: line.quantity,
        });
        atRisk += line.lineTotalMinor;
        continue;
      }

      const usable =
        ctx.catalog.freeStock(line.productId) +
        (heldForThisQuote.get(line.productId) ?? 0);

      if (usable < line.quantity) {
        shortages.push({
          productId: line.productId,
          name: line.name,
          issue: "insufficient_stock",
          requestedQuantity: line.quantity,
          quotedInventoryVersion: line.inventoryVersion,
          currentInventoryVersion: record.version,
          currentAvailable: record.available,
          usableQuantity: usable,
        });
        atRisk += line.lineTotalMinor;
      }
    }

    if (shortages.length > 0) {
      return violation({
        message:
          `Inventory changed after quote approval. ` +
          shortages
            .map((s) =>
              s.issue === "insufficient_stock"
                ? `${s.name}: quantity ${s.requestedQuantity} requested but ` +
                  `${s.usableQuantity} usable (stock now ${s.currentAvailable}, ` +
                  `inventory version v${s.quotedInventoryVersion} → v${s.currentInventoryVersion})`
                : `${s.name}: no inventory record`,
            )
            .join("; ") +
          ".",
        observed: { shortages },
        expected: { allLinesAvailableAndReserved: true },
        moneyAtRiskMinor: atRisk,
        remediation:
          "Re-read inventory immediately before creating a payment; release the " +
          "reservation and ask the buyer to approve a replacement.",
      });
    }

    // Checkout additionally requires an active hold, not merely availability.
    if (
      ctx.checkpoint === "checkout.requested" &&
      ctx.policy.inventory.reserveBeforeCheckout
    ) {
      if (!quote.reservationId || !reservation) {
        return violation({
          message:
            `Checkout requested without an inventory reservation. Stock is ` +
            `available but nothing is held, so a concurrent order can take it ` +
            `between authorisation and capture.`,
          observed: { reservationId: quote.reservationId ?? null },
          expected: { activeReservation: true },
          moneyAtRiskMinor: quote.totalMinor,
          remediation: "Reserve stock at quote time and verify the hold here.",
        });
      }
      if (reservation.status !== "held") {
        return violation({
          message:
            `Reservation ${reservation.id} is '${reservation.status}', not ` +
            `'held', so the stock backing this checkout is no longer secured.`,
          observed: { reservationStatus: reservation.status },
          expected: { reservationStatus: "held" },
          moneyAtRiskMinor: quote.totalMinor,
          remediation:
            "Re-reserve stock and re-confirm with the buyer before charging.",
        });
      }
      if (ctx.clock.nowMs() > reservation.expiresAt.getTime()) {
        return violation({
          message:
            `Reservation ${reservation.id} expired at ` +
            `${reservation.expiresAt.toISOString()}; the hold lapsed before ` +
            `checkout was attempted.`,
          observed: { reservationExpiresAt: reservation.expiresAt.toISOString() },
          expected: { reservationStillWithinWindow: true },
          moneyAtRiskMinor: quote.totalMinor,
          remediation: "Re-reserve and re-approve.",
        });
      }
    }

    return pass("All lines available and held");
  },
};
