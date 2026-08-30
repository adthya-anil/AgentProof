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
          Two levels of chrome, the way a payments dashboard is built: a dark bar that carries
          identity across the full width, and a white rail beneath it that carries navigation.
          The brand belongs in the bar rather than above the nav — it is about the product, not
          about which page you are on, and putting it in the rail made the first navigation
          group start a third of the way down the screen.
        */}
        <header className="topbar">
          <div className="masthead">
            <h1>AgentProof</h1>
          </div>
          <p className="tagline">
            Test every path an AI buyer might take before money moves.
          </p>
        </header>
        <div className="rail" aria-hidden="true" />
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
