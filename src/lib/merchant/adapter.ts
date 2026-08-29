import type {
  InventoryRecord,
  Product,
  ProductCategory,
  Reservation,
} from "../core/types.js";
import { type Capability, CapabilitySet } from "../policy/capabilities.js";
import type { LiveCatalogView } from "../policy/invariants/types.js";
import {
  MappingError,
  type MerchantSchema,
  derivedVersion,
  readList,
  readMoney,
  readPath,
  readTriState,
} from "./mapping.js";

/**
 * A merchant's catalogue, translated into the entity model the invariants expect.
 *
 * The central problem is not the field names — it is that `LiveCatalogView` is
 * synchronous and an HTTP read is not. Two ways out:
 *
 *   1. Make `evaluate` async. Every invariant, every test, and the engine's error
 *      handling all change, and each rule then awaits its own reads. Two rules at the
 *      same checkpoint would fetch separately and could see different prices, so a
 *      report could contain a price-binding pass and an inventory violation computed
 *      against different states. Internally inconsistent, and untraceable afterwards.
 *   2. Resolve everything the checkpoint needs first, then hand the rules a synchronous
 *      view over that one snapshot.
 *
 * This is the second. It keeps the rules synchronous and deterministic, and it gives a
 * stronger guarantee than the current code has: every rule at a checkpoint sees exactly
 * the same catalogue state. `MerchantState` already behaves that way by being in-process
 * and instantaneous; a snapshot makes it explicit rather than incidental.
 *
 * The freshness the existing comment insists on — "live state, re-read at every
 * checkpoint, never a cached snapshot" — is preserved, because a new snapshot is taken
 * per checkpoint. What is forbidden is reusing one across checkpoints, which is the
 * thing that would let a mid-journey price change go unnoticed.
 */
export class CatalogSnapshot implements LiveCatalogView {
  constructor(
    private readonly products: ReadonlyMap<string, Product>,
    private readonly inventory: ReadonlyMap<string, InventoryRecord>,
    /**
     * Reservations, when the merchant has the concept.
     *
     * Kept alongside rather than fetched, because a read-only catalogue API cannot hold
     * stock. When a merchant does not support reservations the inventory rule is
     * withheld, so this is never consulted in that case.
     */
    private readonly reservations: ReadonlyMap<string, Reservation> = new Map(),
  ) {}

  getProduct(productId: string): Product | undefined {
    return this.products.get(productId);
  }

  getInventory(productId: string): InventoryRecord | undefined {
    return this.inventory.get(productId);
  }

  freeStock(productId: string): number {
    const record = this.inventory.get(productId);
    if (!record) return 0;
    return Math.max(0, record.available - record.reserved);
  }

  getReservation(reservationId: string): Reservation | undefined {
    return this.reservations.get(reservationId);
  }

  /** Ids this snapshot actually resolved, for diagnosing an empty result. */
  get resolvedIds(): string[] {
    return [...this.products.keys()];
  }
}

/** Fetches raw product objects. One implementation per transport. */
export interface CatalogTransport {
  readonly kind: string;
  /** Returns one raw object per id it could resolve, keyed by the id requested. */
  fetch(ids: readonly string[]): Promise<Map<string, unknown>>;
  /**
   * Reads a whole catalogue listing.
   *
   * Optional because fetch-by-id is enough to verify a quote. It is not enough to let an
   * agent shop, and a transport that cannot list says so by not implementing this rather
   * than by returning nothing.
   */
  list?(operation: string, root?: string): Promise<unknown[]>;
}

/**
 * Turns a mapping plus a transport into a capability-aware catalogue source.
 *
 * The capability set is *derived* from the mapping rather than declared beside it. A
 * merchant cannot claim `product.priceVersion` without saying which field it comes
 * from, so the claim and the evidence for it are the same line of configuration and
 * cannot drift apart — which is the failure mode a hand-written `capabilities: [...]`
 * list would have invited.
 */
export class MerchantAdapter {
  constructor(
    readonly schema: MerchantSchema,
    private readonly transport: CatalogTransport,
  ) {}

  get label(): string {
    return this.schema.label;
  }

  /**
   * What this merchant can answer, worked out from what the mapping fills in.
   *
   * `approval.contentHash` is always present because the Guard mints approvals itself;
   * it is listed as a capability to document the dependency, not because a merchant
   * could fail to provide it.
   */
  capabilities(): CapabilitySet {
    const present: Capability[] = ["product.lookup", "approval.contentHash"];
    const { product, inventory, derive, supportsReservations } = this.schema;

    if (product.priceVersion || derive.priceVersion) {
      present.push("product.priceVersion");
    }
    if (product.allergens) present.push("product.allergens");
    if (product.vegan) present.push("product.vegan");
    if (inventory.available) present.push("inventory.available");
    if (inventory.version || (derive.inventoryVersion && inventory.available)) {
      present.push("inventory.version");
    }
    if (supportsReservations) present.push("reservation.lookup");

    return CapabilitySet.of(present);
  }

  /**
   * Which capabilities are synthesised rather than supplied by the merchant.
   *
   * Surfaced separately so a report can say "derived from price content" instead of
   * implying the merchant guarantees a version. A synthesised version cannot see a
   * change that was reverted, and a reader is entitled to know which kind they have.
   */
  derivedCapabilities(): Capability[] {
    const derived: Capability[] = [];
    const { product, inventory, derive } = this.schema;
    if (!product.priceVersion && derive.priceVersion) {
      derived.push("product.priceVersion");
    }
    if (!inventory.version && derive.inventoryVersion && inventory.available) {
      derived.push("inventory.version");
    }
    return derived;
  }

  /**
   * Every product id this merchant sells, for a run that shops rather than verifies.
   *
   * Explicit ids win when given: they are a statement about what is under test, which a
   * listing endpoint is not. Throws rather than returning an empty list when the mapping
   * declares no way to enumerate — an empty catalogue would run a whole suite against a
   * shop with nothing in it and report the result as though it meant something.
   */
  async listIds(): Promise<string[]> {
    const { catalogue, product } = this.schema;
    if (catalogue.ids && catalogue.ids.length > 0) return [...catalogue.ids];

    const operation = catalogue.listQuery ?? catalogue.listPath;
    if (!operation) {
      throw new Error(
        `${this.schema.label} has no way to enumerate its catalogue. Add ` +
          `catalogue.ids, catalogue.listQuery or catalogue.listPath to the mapping — ` +
          `an agent cannot shop a merchant it cannot browse.`,
      );
    }
    if (!this.transport.list) {
      throw new Error(
        `the ${this.transport.kind} transport cannot list a catalogue`,
      );
    }

    const rows = await this.transport.list(operation, catalogue.root);
    const ids = rows
      .map((row) => readPath(row, product.id))
      .filter((id): id is string | number => typeof id === "string" || typeof id === "number")
      .map(String);
    if (ids.length === 0) {
      throw new Error(
        `catalogue listing returned ${rows.length} rows but no ids resolved at ` +
          `'${product.id}'`,
      );
    }
    return [...new Set(ids)];
  }

  /** Reads the given products and returns a synchronous view over the result. */
  async snapshot(
    productIds: readonly string[],
    reservations: ReadonlyMap<string, Reservation> = new Map(),
  ): Promise<CatalogSnapshot> {
    const wanted = [...new Set(productIds)];
    if (wanted.length === 0) {
      return new CatalogSnapshot(new Map(), new Map(), reservations);
    }

    const raw = await this.transport.fetch(wanted);
    const products = new Map<string, Product>();
    const inventory = new Map<string, InventoryRecord>();

    for (const [id, source] of raw) {
      products.set(id, this.toProduct(id, source));
      const record = this.toInventory(id, source);
      if (record) inventory.set(id, record);
    }

    return new CatalogSnapshot(products, inventory, reservations);
  }

  private toProduct(id: string, source: unknown): Product {
    const { product, derive } = this.schema;
    const priceMinor = readMoney(source, product.price);

    const name = readPath(source, product.name);
    if (typeof name !== "string" || name.trim() === "") {
      // Named products are not cosmetic: every violation message identifies the item,
      // and "undefined: 2 requested but only 1 available" is not a usable finding.
      throw new MappingError("no product name", product.name);
    }

    let priceVersion: number;
    if (product.priceVersion) {
      const raw = readPath(source, product.priceVersion);
      if (raw === undefined || raw === null) {
        throw new MappingError("mapped but absent price version", product.priceVersion);
      }
      // Anything stable and comparable will do — an integer counter, an updated_at
      // timestamp, an etag. Hashed to a number because the entity model says number,
      // and equality is all either version rule tests.
      priceVersion =
        typeof raw === "number" && Number.isInteger(raw) && raw >= 0
          ? raw
          : derivedVersion(String(raw));
    } else if (derive.priceVersion) {
      priceVersion = derivedVersion(priceMinor, this.schema.currency);
    } else {
      // Unreachable in practice: without either, `product.priceVersion` is not a
      // declared capability and every rule that reads this field is withheld. A stable
      // constant rather than a throw, so an unrelated rule at the same checkpoint is
      // not taken down by a field it never looks at.
      priceVersion = 0;
    }

    return {
      id,
      name: name.trim(),
      category: this.toCategory(source),
      priceMinor,
      priceVersion,
      allergens: product.allergens ? readList(source, product.allergens) : null,
      vegan: product.vegan ? readTriState(source, product.vegan) : null,
      bundleEligible: product.bundleEligible
        ? (readTriState(source, product.bundleEligible) ?? false)
        : true,
      // No floor declared means the list price is the floor, which is the strictest
      // reading. Assuming a merchant will discount below a price it never published
      // would invent permission it did not grant.
      minPriceMinor: product.minPrice
        ? readMoney(source, product.minPrice)
        : priceMinor,
    };
  }

  private toInventory(id: string, source: unknown): InventoryRecord | null {
    const { inventory, derive } = this.schema;
    if (!inventory.available) return null;

    const raw = readPath(source, inventory.available);
    const available =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw)
          ? Number(raw)
          : null;
    if (available === null) {
      throw new MappingError(
        `stock is not a count: '${String(raw)}'. A boolean cannot answer how many ` +
          `remain; leave inventory.available unmapped instead`,
        inventory.available,
      );
    }

    let version: number;
    if (inventory.version) {
      const rawVersion = readPath(source, inventory.version);
      version =
        typeof rawVersion === "number" && Number.isInteger(rawVersion)
          ? rawVersion
          : derivedVersion(String(rawVersion));
    } else if (derive.inventoryVersion) {
      version = derivedVersion(available);
    } else {
      version = 0;
    }

    return {
      productId: id,
      available,
      // A remote catalogue reports what is free, not what this engine is holding.
      // Reservations are tracked locally, so double-counting them here would show
      // stock as unavailable twice.
      reserved: 0,
      version,
    };
  }

  private toCategory(source: unknown): ProductCategory {
    const mapping = this.schema.product.category;
    if (!mapping) return this.schema.defaultCategory;
    const raw = readPath(source, mapping.path);
    if (typeof raw !== "string") return mapping.fallback;
    return mapping.map[raw.trim()] ?? mapping.fallback;
  }
}
