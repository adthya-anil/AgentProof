import Link from "next/link";
import { formatMinor } from "@/lib/core/money";
import type { IntegrationVariant } from "@/lib/dashboard/data";
import {
  SHOWCASE_OPTIONS,
  runShowcase,
  showcaseOptionByKey,
} from "@/lib/dashboard/showcase";
import {
  ChainStatus,
  DispositionBadge,
  Tabs,
  Trace,
  ViolationCard,
} from "../../components";

export const dynamic = "force-dynamic";

function parseVariant(value: string | undefined): IntegrationVariant {
  return value === "fixed" ? "fixed" : "vulnerable";
}

/**
 * Watch a buyer agent shop.
 *
 * Runs one real journey on demand and shows the agent's tool calls, the quote it
 * produced, and the Guard's verdict at each lifecycle checkpoint. The variant
 * switch reruns the *identical* buyer request against the other integration,
 * which is the most convincing thing available: the buyer behaves the same, only
 * the merchant's code differs, so nothing about the failure can be blamed on a
 * different input.
 */
export default async function AgentShowcasePage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; integration?: string }>;
}) {
  const params = await searchParams;
  const variant = parseVariant(params.integration);
  const option = showcaseOptionByKey(params.request ?? "happy");
  const result = await runShowcase(option.key, variant);

  return (
    <>
      <Tabs active="hamperhub" variant={variant} />
      <Link className="back" href="/hamperhub">
        ← back to the storefront
      </Link>

      <div className="panel">
        <h2>Buyer request</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {SHOWCASE_OPTIONS.map((entry) => (
            <Link
              key={entry.key}
              href={`/hamperhub/agent?request=${entry.key}&integration=${variant}`}
              className="badge"
              style={{
                padding: "0.3rem 0.7rem",
                borderColor:
                  entry.key === option.key ? "var(--accent)" : "var(--border)",
                color: entry.key === option.key ? "var(--text)" : "var(--muted)",
                background:
                  entry.key === option.key ? "var(--panel-2)" : "transparent",
              }}
            >
              {entry.label}
            </Link>
          ))}
        </div>
        <p className="note" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
          {option.blurb}
        </p>
      </div>

      <div className="panel">
        <h2>Integration under test</h2>
        <div className="switcher" style={{ marginBottom: 0 }}>
          <Link
            href={`/hamperhub/agent?request=${option.key}&integration=vulnerable`}
            data-active={String(variant === "vulnerable")}
          >
            Vulnerable
          </Link>
          <Link
            href={`/hamperhub/agent?request=${option.key}&integration=fixed`}
            data-active={String(variant === "fixed")}
          >
            Fixed
          </Link>
        </div>
        <p className="note" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
          Same buyer request either way. Only the merchant&apos;s code changes.
        </p>
      </div>

      {!result ? (
        <div className="panel">
          <p className="empty">That scenario is unavailable.</p>
        </div>
      ) : (
        <>
          <div className="panel">
            <h2>Outcome</h2>
            {result.utterance && (
              <blockquote
                style={{
                  margin: "0 0 0.9rem",
                  paddingLeft: "0.85rem",
                  borderLeft: "3px solid var(--border)",
                  color: "var(--muted)",
                  fontSize: "0.9rem",
                }}
              >
                “{result.utterance}”
              </blockquote>
            )}
            <div className="meta">
              <div>
                <span>Result</span>
                <DispositionBadge value={result.disposition} />
              </div>
              <div>
                <span>Payable orders created</span>
                {result.providerOrders}
              </div>
              <div>
                <span>Money at risk</span>
                {formatMinor(result.moneyAtRiskMinor)}
              </div>
              <div>
                <span>Merchant defects</span>
                {result.defects.length}
              </div>
            </div>
            <p className="note" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
              {result.note}
            </p>
          </div>

          {result.perturbations.length > 0 && (
            <div className="panel">
              <h2>What the environment did</h2>
              <ul className="trace">
                {result.perturbations.map((detail, index) => (
                  <li key={index}>
                    <span className="off">env</span>
                    <span className="ev">{detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="panel">
            <h2>Agent tool calls ({result.toolCalls.length})</h2>
            {result.toolCalls.length === 0 ? (
              <p className="empty">The agent made no tool calls.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "2rem" }} />
                    <th>Tool</th>
                    <th>Arguments the agent chose</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {result.toolCalls.map((call) => (
                    <tr key={call.seq}>
                      <td style={{ color: call.ok ? "var(--ok)" : "var(--bad)" }}>
                        {call.ok ? "✓" : "✗"}
                      </td>
                      <td>
                        <code>{call.tool}</code>
                      </td>
                      <td className="mono note">{call.args}</td>
                      <td className="note">{call.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {result.quote && (
            <div className="panel">
              <h2>Quote the agent produced</h2>
              <table>
                <tbody>
                  {result.quote.lines.map((line, index) => (
                    <tr key={index}>
                      <td>
                        {line.quantity > 1 ? `${line.quantity} × ` : ""}
                        {line.name}
                      </td>
                      <td className="num">₹{line.lineTotal.toFixed(2)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="note">Subtotal</td>
                    <td className="num note">
                      ₹{result.quote.subtotal.toFixed(2)}
                    </td>
                  </tr>
                  {result.quote.discounts.map((discount) => (
                    <tr key={discount.code}>
                      <td className="note">
                        <code>{discount.code}</code>
                      </td>
                      <td className="num note">
                        −₹{discount.amount.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <strong>Payable total</strong>
                    </td>
                    <td className="num">
                      <strong>₹{result.quote.total.toFixed(2)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="panel">
            <h2>Guard verdicts by checkpoint</h2>
            {result.checkpoints.length === 0 ? (
              <p className="empty">No policy evaluation ran.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Checkpoint</th>
                    <th>Decision</th>
                    <th className="num">Rules</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.checkpoints.map((checkpoint, index) => (
                    <tr key={index}>
                      <td className="mono">{checkpoint.checkpoint}</td>
                      <td>
                        <span
                          className={`badge ${
                            checkpoint.decision === "allow"
                              ? "passed"
                              : checkpoint.decision === "escalate"
                                ? "escalated"
                                : "unsafe_violation"
                          }`}
                        >
                          {checkpoint.decision}
                        </span>
                      </td>
                      <td className="num note">
                        {checkpoint.passed}/{checkpoint.evaluated}
                      </td>
                      <td className="note">{checkpoint.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {(result.violations.length > 0 || result.escalations.length > 0) && (
            <div className="panel">
              <h2>Findings</h2>
              {result.violations.map((violation) => (
                <ViolationCard
                  key={violation.id}
                  violation={violation}
                  kind="violation"
                  variant={variant}
                />
              ))}
              {result.escalations.map((violation) => (
                <ViolationCard
                  key={violation.id}
                  violation={violation}
                  kind="escalation"
                  variant={variant}
                />
              ))}
            </div>
          )}

          <div className="panel">
            <h2>Developer explanation</h2>
            <pre>{result.explanation}</pre>
          </div>

          <div className="panel">
            <h2>Full audit trail</h2>
            <Trace events={result.auditTrail} />
            <div style={{ marginTop: "1rem" }}>
              <ChainStatus
                ok={result.auditChainOk}
                events={result.auditTrail.length}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}
