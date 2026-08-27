import { formatMinor } from "@/lib/core/money";
import { getSuiteView } from "@/lib/dashboard/data";
import { ALL_INVARIANTS } from "@/lib/policy/invariants/index";
import { Tabs } from "../components";

export const dynamic = "force-dynamic";

/**
 * The enforced policy and the invariants derived from it.
 *
 * Shown together deliberately: the policy is the contract, and each invariant
 * names the policy keys it enforces, so a reviewer can trace any verdict back to
 * a rule the merchant approved.
 */
export default async function PolicyPage() {
  const { info } = await getSuiteView("fixed");
  const policy = info.policy;

  return (
    <>
      <Tabs active="policy" variant="fixed" />

      <div className="panel">
        <h2>Merchant policy</h2>
        <div className="meta" style={{ marginBottom: "1rem" }}>
          <div>
            <span>Policy id</span>
            <code>{policy.policyId}</code>
          </div>
          <div>
            <span>Content-addressed version</span>
            <code>{info.policyVersion}</code>
          </div>
          <div>
            <span>Currency</span>
            {policy.currency}
          </div>
        </div>
        <p className="note" style={{ marginTop: 0 }}>
          An LLM may draft this document from a natural-language description, but
          the developer approves the structured version and only the structured
          version is enforced. Nothing downstream reads the original prompt.
        </p>

        <div className="grid-2" style={{ marginTop: "1rem" }}>
          <div className="kv">
            <div>
              <span>Maximum transaction</span>
              <span>{formatMinor(policy.transaction.maximumAmountMinor)}</span>
            </div>
            <div>
              <span>Quote expiry</span>
              <span>{policy.transaction.quoteExpiryMinutes} min</span>
            </div>
            <div>
              <span>Buyer confirmation required</span>
              <span>{String(policy.transaction.requireBuyerConfirmation)}</span>
            </div>
            <div>
              <span>One payment per intent</span>
              <span>{String(policy.transaction.onePaymentPerIntent)}</span>
            </div>
            <div>
              <span>Maximum discount</span>
              <span>{policy.pricing.maximumDiscountPercent}%</span>
            </div>
            <div>
              <span>Discount stacking</span>
              <span>
                {policy.pricing.allowDiscountStacking ? "allowed" : "forbidden"}
              </span>
            </div>
          </div>
          <div className="kv">
            <div>
              <span>Payment must equal approved quote</span>
              <span>
                {String(policy.pricing.paymentMustEqualApprovedQuote)}
              </span>
            </div>
            <div>
              <span>Floor price enforced</span>
              <span>{String(policy.pricing.enforceFloorPrice)}</span>
            </div>
            <div>
              <span>Require current availability</span>
              <span>
                {String(policy.inventory.requireCurrentAvailability)}
              </span>
            </div>
            <div>
              <span>Reserve before checkout</span>
              <span>{String(policy.inventory.reserveBeforeCheckout)}</span>
            </div>
            <div>
              <span>Reservation window</span>
              <span>{policy.inventory.reservationMinutes} min</span>
            </div>
            <div>
              <span>Unknown allergen data</span>
              <span>{policy.products.unknownAllergenStatus}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Deterministic invariants ({ALL_INVARIANTS.length})</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Verdicts are arithmetic. No invariant consults an LLM, and none knows
          which defect is active.
        </p>
        <table>
          <thead>
            <tr>
              <th>Invariant</th>
              <th>Rule</th>
              <th>Policy keys</th>
              <th>Checkpoints</th>
            </tr>
          </thead>
          <tbody>
            {ALL_INVARIANTS.map((invariant) => (
              <tr key={invariant.id}>
                <td>
                  <code>{invariant.id}</code>
                  <div>
                    <span className={`badge ${invariant.severity}`}>
                      {invariant.severity}
                    </span>
                  </div>
                </td>
                <td>{invariant.title}</td>
                <td className="mono note">
                  {invariant.policyRefs.join(", ") || "—"}
                </td>
                <td className="mono note">
                  {invariant.appliesAt.join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
