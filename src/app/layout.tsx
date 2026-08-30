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
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="topbar">
          <div className="masthead">
            <span className="brand-mark" aria-hidden="true" />
            <div className="brand-lockup">
              <h1>AgentProof</h1>
              <span>AI commerce assurance</span>
            </div>
          </div>
          <p className="tagline">
            Test every path an AI buyer might take before money moves.
          </p>
          <div className="topbar-mode" aria-label="Product scope">
            <span aria-hidden="true" />
            Preflight + runtime controls
          </div>
        </header>
        <div className="rail" aria-hidden="true" />
        <main className="shell" id="main-content">
          {children}
        </main>
      </body>
    </html>
  );
}
