import type { Clock } from "../core/clock.js";
import { minutesFrom } from "../core/clock.js";
import type { IdFactory } from "../core/ids.js";
import type { Minor } from "../core/money.js";
import type {
  InventoryRecord,
  Product,
  Reservation,
} from "../core/types.js";
import { SEED_CATALOG, SEED_INVENTORY } from "./catalog.js";

export interface StateChange {
  kind: "price" | "inventory";
  productId: string;
  from: number;
  to: number;
  newVersion: number;
  reason: string;
}

/**
 * Mutable merchant state: catalog prices, stock levels and reservations.
 *
 * Every mutation bumps a monotonic version. Quotes capture those versions, and
 * the Guard compares captured versions against live ones at checkout. That
 * comparison is what makes "the price changed after approval" detectable
 * without diffing amounts and guessing.
 *
 * State changes are recorded so a preflight report can show exactly which
 * perturbation caused a violation.
 */
export class MerchantState {
  private products = new Map<string, Product>();
  private inventory = new Map<string, InventoryRecord>();
  private reservations = new Map<string, Reservation>();
  private changes: StateChange[] = [];
  private observers = new Set<(change: StateChange) => void>();

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdFactory,
  ) {
    this.reset();
  }

  /**
   * Watch price and stock mutations as they happen.
   *
   * Exists so the Guard can put them in the audit log. Without it the trail
   * recorded that `INV-PRICE-BINDING` had fired but not that a price had changed:
   * a reader saw a quote agreed, an approval, then a checkout blocked for
   * "catalog prices changed", with no entry anywhere saying what changed, when, or
   * why. The cause of the most interesting violations was the one thing missing
   * from the record of them.
   *
   * Returns an unsubscribe function. Observer errors are swallowed, because a
   * listener must never be able to break a state mutation.
   */
  observeChanges(observer: (change: StateChange) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  private notify(change: StateChange): void {
    for (const observer of this.observers) {
      try {
        observer(change);
      } catch {
        // A broken listener must not corrupt merchant state.
      }
    }
  }

  reset(): void {
    this.products.clear();
    this.inventory.clear();
    this.reservations.clear();
    this.changes = [];
    for (const product of SEED_CATALOG) {
      this.products.set(product.id, { ...product });
      this.inventory.set(product.id, {
        productId: product.id,
        available: SEED_INVENTORY[product.id] ?? 0,
        reserved: 0,
        version: 1,
      });
    }
  }

  /**
   * Replaces the catalogue with one loaded from a real merchant.
   *
   * Necessary because pricing and verification must share a single origin. A quote
   * priced from the seed catalogue carries `priceVersion: 1`, while a checkpoint
   * re-reading through an adapter sees a version derived from the merchant's own
   * data — so INV-PRICE-BINDING compared 1 against a hash, found them different, and
   * reported that the price had moved while quoting the same ₹599.00 on both sides of
   * the message. A false violation is worse than a withheld rule: it accuses a correct
   * integration of a defect, and the report even shows the two identical prices.
   *
   * So the merchant's catalogue is loaded once, up front, and everything downstream —
   * pricing, reservations, and every checkpoint re-read — descends from it.
   */
  loadCatalog(
    products: readonly Product[],
    stock: ReadonlyMap<string, number>,
  ): void {
    this.products.clear();
    this.inventory.clear();
    this.reservations.clear();
    this.changes = [];
    for (const product of products) {
      // Versions restart at 1 regardless of what the merchant called them. They are
      // this engine's own counters from here on, bumped by syncFromMerchant when a
      // remote value actually moves.
      this.products.set(product.id, { ...product, priceVersion: 1 });
      this.inventory.set(product.id, {
        productId: product.id,
        available: stock.get(product.id) ?? 0,
        reserved: 0,
        version: 1,
      });
    }
  }

  /**
   * Folds a fresh merchant reading into the local catalogue.
   *
   * The alternative — handing the invariants the remote snapshot directly — does not
   * work, and finding out why was the most useful thing the adapter tests did. A quote
   * is priced from this catalogue and carries its `priceVersion`; a checkpoint reading
   * the merchant separately produces a version from the merchant's own data. The two
   * are not comparable, so INV-PRICE-BINDING compared 1 against a hash, found them
   * different, and reported that the price had moved — while quoting the same ₹599.00
   * on both sides of its own message. A false violation accusing a correct integration,
   * with the evidence of its own wrongness printed in it.
   *
   * So there is one catalogue and the merchant is synchronised into it. Versions stay
   * monotonic counters, which is what the rules want and what a content hash cannot be.
   * It also restores a property hashing had to give up: A → B → A is version 3 here,
   * so a price that moved and moved back is still visible as having moved.
   *
   * Routed through setPrice and setStock rather than writing the maps directly, so a
   * merchant-side change is recorded as a StateChange and reaches the audit trail.
   * Without that, a reader would see a checkout blocked for "catalog prices changed"
   * with no entry anywhere saying what changed or when.
   */
  syncFromMerchant(
    remote: Product,
    remoteInventory: InventoryRecord | undefined,
  ): StateChange[] {
    const changes: StateChange[] = [];
    const local = this.products.get(remote.id);

    if (!local) {
      // A product the merchant has and this catalogue does not. Added rather than
      // ignored, so a bundle referencing it can be priced.
      this.products.set(remote.id, { ...remote, priceVersion: 1 });
      this.inventory.set(remote.id, {
        productId: remote.id,
        available: remoteInventory?.available ?? 0,
        reserved: 0,
        version: 1,
      });
      return changes;
    }

    if (local.priceMinor !== remote.priceMinor) {
      changes.push(
        this.setPrice(remote.id, remote.priceMinor, "merchant catalogue re-read"),
      );
    }

    // Safety and floor data are not versioned, so they are refreshed in place. A
    // merchant correcting an allergen list mid-journey should be honoured immediately;
    // the alternative is checking a buyer's allergy against data known to be stale.
    const current = this.products.get(remote.id);
    if (current) {
      current.allergens = remote.allergens;
      current.vegan = remote.vegan;
      current.minPriceMinor = remote.minPriceMinor;
      current.bundleEligible = remote.bundleEligible;
    }

    if (remoteInventory) {
      const localInventory = this.inventory.get(remote.id);
      /**
       * Compared against what the merchant believes is free, plus what this engine is
       * holding.
       *
       * A remote catalogue reports availability with our own reservations already
       * deducted — it has no idea they exist, but the stock is gone from its count all
       * the same once it is committed. Comparing its number to our `available` without
       * adding back what we hold would look like a stock drop on every reservation and
       * fire the inventory rule against ourselves.
       */
      const expected = remote.id
        ? remoteInventory.available + (localInventory?.reserved ?? 0)
        : remoteInventory.available;
      if (localInventory && localInventory.available !== expected) {
        changes.push(
          this.setStock(remote.id, expected, "merchant catalogue re-read"),
        );
      }
    }

    return changes;
  }

  // -- reads ---------------------------------------------------------------

  listProducts(): Product[] {
    return [...this.products.values()].map((p) => ({ ...p }));
  }

  getProduct(productId: string): Product | undefined {
    const product = this.products.get(productId);
    return product ? { ...product } : undefined;
  }

  requireProduct(productId: string): Product {
    const product = this.getProduct(productId);
    if (!product) throw new Error(`Unknown product: ${productId}`);
    return product;
  }

  getInventory(productId: string): InventoryRecord | undefined {
    const record = this.inventory.get(productId);
    return record ? { ...record } : undefined;
  }

  requireInventory(productId: string): InventoryRecord {
    const record = this.getInventory(productId);
    if (!record) throw new Error(`No inventory record for ${productId}`);
    return record;
  }

  /** Stock not already held by a reservation. */
  freeStock(productId: string): number {
    const record = this.requireInventory(productId);
    return Math.max(0, record.available - record.reserved);
  }

  stateChanges(): readonly StateChange[] {
    return this.changes;
  }

  // -- perturbations -------------------------------------------------------

  setPrice(productId: string, priceMinor: Minor, reason: string): StateChange {
    const product = this.products.get(productId);
    if (!product) throw new Error(`Unknown product: ${productId}`);
    const change: StateChange = {
      kind: "price",
      productId,
      from: product.priceMinor,
      to: priceMinor,
      newVersion: product.priceVersion + 1,
      reason,
    };
    product.priceMinor = priceMinor;
    product.priceVersion = change.newVersion;
    this.changes.push(change);
    this.notify(change);
    return change;
  }

  setStock(productId: string, available: number, reason: string): StateChange {
    const record = this.inventory.get(productId);
    if (!record) throw new Error(`No inventory record for ${productId}`);
    const change: StateChange = {
      kind: "inventory",
      productId,
      from: record.available,
      to: available,
      newVersion: record.version + 1,
      reason,
    };
    record.available = available;
    record.version = change.newVersion;
    this.changes.push(change);
    this.notify(change);
    return change;
  }

  /**
   * Hard stock-out: availability drops to zero and existing holds are broken.
   *
   * Models a physical reality — breakage, a stock-take correction, a warehouse
   * discrepancy — where the merchant simply cannot honour a reservation. This is
   * distinct from `setStock`, which lowers availability while leaving valid
   * holds intact, because a reservation that is still backed by stock should not
   * block a sale.
   */
  forceStockOut(
    productId: string,
    reason: string,
  ): { change: StateChange; releasedReservations: string[] } {
    const released: string[] = [];
    for (const reservation of this.reservations.values()) {
      if (
        reservation.status === "held" &&
        reservation.items.some((item) => item.productId === productId)
      ) {
        this.releaseReservation(reservation.id);
        released.push(reservation.id);
      }
    }
    const change = this.setStock(productId, 0, reason);
    const record = this.inventory.get(productId);
    if (record) record.reserved = 0;
    return { change, releasedReservations: released };
  }

  // -- reservations --------------------------------------------------------

  /**
   * Holds stock for a quote. Returns null when any line cannot be satisfied;
   * the caller decides whether that is a hard failure or an escalation.
   */
  reserve(
    quoteId: string,
    items: Array<{ productId: string; quantity: number }>,
    minutes: number,
  ): Reservation | null {
    for (const item of items) {
      if (this.freeStock(item.productId) < item.quantity) return null;
    }
    const reservation: Reservation = {
      id: this.ids.next("res"),
      quoteId,
      items: items.map((item) => ({ ...item })),
      expiresAt: minutesFrom(this.clock, minutes),
      status: "held",
    };
    for (const item of items) {
      const record = this.inventory.get(item.productId)!;
      record.reserved += item.quantity;
    }
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  /**
   * Every reservation, for handing to a catalogue adapter.
   *
   * A remote catalogue cannot hold stock — it reports what is free and nothing more —
   * so holds are tracked here and passed to the adapter, which would otherwise present
   * an inventory rule with a reservation id it has never heard of.
   */
  allReservations(): ReadonlyMap<string, Reservation> {
    return new Map(this.reservations);
  }

  getReservation(reservationId: string): Reservation | undefined {
    const reservation = this.reservations.get(reservationId);
    return reservation ? { ...reservation } : undefined;
  }

  /** Returns held stock to the pool. Idempotent. */
  releaseReservation(reservationId: string): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== "held") return false;
    for (const item of reservation.items) {
      const record = this.inventory.get(item.productId);
      if (record) record.reserved = Math.max(0, record.reserved - item.quantity);
    }
    reservation.status = "released";
    return true;
  }

  /** Converts a hold into a real stock decrement after payment succeeds. */
  commitReservation(reservationId: string): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== "held") return false;
    for (const item of reservation.items) {
      const record = this.inventory.get(item.productId);
      if (!record) continue;
      record.reserved = Math.max(0, record.reserved - item.quantity);
      record.available = Math.max(0, record.available - item.quantity);
      record.version += 1;
    }
    reservation.status = "committed";
    return true;
  }

  /** Drops holds whose window has elapsed. Called before availability checks. */
  expireStaleReservations(): string[] {
    const expired: string[] = [];
    for (const reservation of this.reservations.values()) {
      if (
        reservation.status === "held" &&
        this.clock.nowMs() > reservation.expiresAt.getTime()
      ) {
        this.releaseReservation(reservation.id);
        expired.push(reservation.id);
      }
    }
    return expired;
  }
}
