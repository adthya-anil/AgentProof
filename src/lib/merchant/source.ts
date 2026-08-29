import { CapabilitySet } from "../policy/capabilities.js";
import type { LiveCatalogView } from "../policy/invariants/types.js";
import type { MerchantState } from "../hamperhub/state.js";
import type { MerchantAdapter } from "./adapter.js";

/**
 * Where the Guard gets catalogue state for a checkpoint.
 *
 * A seam, so the Guard never learns that adapters exist. It asks for a view over the
 * products a checkpoint cares about and gets one; whether that came from an in-process
 * Map or two HTTP round trips is not its concern, and keeping it that way is what stops
 * transport details leaking into the rules.
 *
 * The method is async because a remote read is. The local implementation resolves
 * immediately, so the offline path pays nothing for the abstraction beyond a
 * microtask.
 */
export interface CatalogSource {
  /** Shown in reports so a reader knows what the rules were run against. */
  readonly describe: string;
  capabilities(): CapabilitySet;
  /** Which capabilities are synthesised rather than merchant-guaranteed. */
  derivedCapabilities(): string[];
  /**
   * A view over exactly these products, read now.
   *
   * Taken fresh per checkpoint. Reusing a view across checkpoints is what would let a
   * mid-journey price change go unnoticed, which is the thing the existing "never a
   * cached snapshot" comment is protecting.
   */
  viewFor(productIds: readonly string[]): Promise<LiveCatalogView>;
  /**
   * Every product the merchant sells.
   *
   * Needed by any run that begins with a search rather than with a known basket, which is
   * every agent-driven journey.
   */
  listIds(): Promise<string[]>;
  /**
   * Loads the merchant's catalogue as the starting state for a run.
   *
   * On the interface rather than only on the adapter, so a caller never has to know which
   * kind of merchant it holds in order to set one up correctly.
   */
  prime(productIds: readonly string[]): Promise<void>;
  /**
   * Changes the merchant's own price for a product, returning false when it cannot.
   *
   * On the interface rather than only on the adapter so a scenario never has to know which
   * kind of merchant it is perturbing. Returning false rather than throwing, because "this
   * merchant cannot be perturbed" is an ordinary fact about a third-party catalogue and the
   * caller's job is to report the journey as not exercised, not to fail.
   */
  setMerchantPrice(productId: string, priceMinor: number): Promise<boolean>;
  /** Changes the merchant's own stock. Same contract as `setMerchantPrice`. */
  setMerchantStock(productId: string, quantity: number): Promise<boolean>;
}

/**
 * The in-process merchant, which is every existing run.
 *
 * Full capabilities, because HamperHub is built to the spec's entity model and
 * genuinely carries a price version, an inventory version and tri-state safety data —
 * asserted in the capability tests rather than assumed here.
 */
export class LocalCatalogSource implements CatalogSource {
  readonly describe = "in-process merchant state";

  constructor(private readonly state: LiveCatalogView) {}

  capabilities(): CapabilitySet {
    return CapabilitySet.full();
  }

  derivedCapabilities(): string[] {
    return [];
  }

  async viewFor(): Promise<LiveCatalogView> {
    // The live object itself, not a copy. Re-reading is instantaneous in-process, and
    // copying would introduce the cached snapshot the design forbids.
    return this.state;
  }

  /**
   * The in-process merchant is its own state, so a local edit *is* a merchant edit.
   *
   * Reported as unsupported anyway, which sounds contradictory and is not: the caller
   * falls back to editing state directly, which for HamperHub is the same thing and keeps
   * its reproductions byte-identical. Claiming support here would route them through an
   * indirection that changes nothing.
   */
  async setMerchantPrice(): Promise<boolean> {
    return false;
  }

  async setMerchantStock(): Promise<boolean> {
    return false;
  }

  async prime(_productIds: readonly string[] = []): Promise<void> {
    // Already loaded: MerchantState seeds itself from the catalogue it ships with. The
    // parameter is accepted and ignored so a caller never has to know which kind of
    // source it is holding in order to set one up correctly.
  }

  async listIds(): Promise<string[]> {
    // The in-process merchant is already fully loaded, so this is just what it holds.
    return "listProducts" in this.state
      ? (this.state as { listProducts(): Array<{ id: string }> })
          .listProducts()
          .map((p) => p.id)
      : [];
  }
}

/**
 * A merchant behind a mapping, synchronised into one catalogue.
 *
 * The obvious implementation returns the remote snapshot as the view. It does not work,
 * and the reason is worth stating because it is not obvious until something breaks: a
 * quote is priced from the local catalogue and carries its `priceVersion`, while a
 * checkpoint reading the merchant separately produces a version from the merchant's own
 * data. Those two numbers are not comparable. INV-PRICE-BINDING compared them, found
 * them different, and reported that the price had moved while quoting the same ₹599.00
 * on both sides of the message — a false violation against a correct integration, with
 * the evidence of its own wrongness printed inside it.
 *
 * So the merchant is folded into the local catalogue instead, and the invariants keep
 * reading one thing. Versions stay monotonic counters rather than hashes, which is what
 * the rules want and which restores a property hashing had to concede: a price that
 * moved and moved back is still visible as having moved.
 *
 * Reservations are not sent to the merchant, because a catalogue API cannot hold stock.
 * They stay local and are accounted for when comparing stock levels.
 */
export class AdapterCatalogSource implements CatalogSource {
  constructor(
    private readonly adapter: MerchantAdapter,
    private readonly state: MerchantState,
  ) {}

  get describe(): string {
    const derived = this.adapter.derivedCapabilities();
    const suffix =
      derived.length > 0 ? ` (${derived.join(", ")} derived)` : "";
    return `${this.adapter.label} via ${this.adapter.schema.transport.kind}${suffix}`;
  }

  capabilities(): CapabilitySet {
    return this.adapter.capabilities();
  }

  derivedCapabilities(): string[] {
    return this.adapter.derivedCapabilities();
  }

  /**
   * Loads the merchant's catalogue as the starting state for a journey.
   *
   * Called once up front so that pricing and verification descend from the same read.
   * Without it, the first quote would be priced from HamperHub's seed catalogue and
   * then checked against someone else's prices.
   */
  async prime(productIds: readonly string[]): Promise<void> {
    const snapshot = await this.adapter.snapshot(productIds);
    const products = productIds
      .map((id) => snapshot.getProduct(id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    const stock = new Map<string, number>();
    for (const product of products) {
      stock.set(product.id, snapshot.getInventory(product.id)?.available ?? 0);
    }
    this.state.loadCatalog(products, stock);
  }

  async listIds(): Promise<string[]> {
    return this.adapter.listIds();
  }

  async setMerchantPrice(productId: string, priceMinor: number): Promise<boolean> {
    // Major units as a string, because that is what a decimal-string catalogue speaks and
    // sending paise to a merchant that quotes rupees would move the price a hundredfold.
    return this.adapter.setMerchantPrice(productId, (priceMinor / 100).toFixed(2));
  }

  async setMerchantStock(productId: string, quantity: number): Promise<boolean> {
    return this.adapter.setMerchantStock(productId, quantity);
  }

  async viewFor(productIds: readonly string[]): Promise<LiveCatalogView> {
    if (productIds.length === 0) return this.state;

    const snapshot = await this.adapter.snapshot(productIds);
    for (const id of productIds) {
      const remote = snapshot.getProduct(id);
      // A product the merchant no longer returns is left alone deliberately. The
      // invariants already treat an unresolvable product as their own finding, and
      // deleting it here would turn a precise verdict into a missing-key crash.
      if (remote) this.state.syncFromMerchant(remote, snapshot.getInventory(id));
    }
    return this.state;
  }
}
