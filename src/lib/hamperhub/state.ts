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
