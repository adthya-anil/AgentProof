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
        {/*
          The rail's surface, drawn separately from what sits on it.
          The brand lives here in the layout, while the navigation is rendered by each page
          (it needs to know which entry is current). Two fixed blocks over one continuous
          background is what lets them read as a single column without the layout having to
          know the active route.
        */}
        <div className="rail" aria-hidden="true" />
        <header className="brand">
          <div className="masthead">
            <h1>AgentProof</h1>
          </div>
          <p className="tagline">
            Test every path an AI buyer might take before money moves.
          </p>
        </header>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
