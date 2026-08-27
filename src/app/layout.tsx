import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentProof",
  description:
    "Preflight testing and runtime policy layer for agentic commerce.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header>
            <div className="masthead">
              <h1>AgentProof</h1>
              <span className="note">
                Test every path an AI buyer might take before money moves.
              </span>
            </div>
            <p className="tagline">
              AI explores; deterministic code decides.
            </p>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
