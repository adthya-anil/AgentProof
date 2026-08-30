import { describe, expect, it } from "vitest";
import {
  resolveMerchantEndpoint,
  validateMerchantEndpoint,
} from "../src/lib/merchant/endpoint.js";

/**
 * The endpoint is a user input, and this runs server-side. That is textbook SSRF: the request
 * leaves from inside the deployment with whatever the deployment can reach.
 *
 * These tests are about the refusals, not the happy path. A validator that accepts a real
 * catalogue is obviously working; one that also accepts `file:///etc/passwd` or the cloud
 * metadata service is obviously not, and the difference is invisible until someone tries.
 */

const BUILT_IN = "http://127.0.0.1:3000/api/merchant/nordwell";

describe("choosing which merchant to test", () => {
  it("falls back to the built-in merchant when nothing was asked for", () => {
    for (const nothing of [null, "", "   "]) {
      const decision = resolveMerchantEndpoint(nothing, BUILT_IN);

      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      expect(decision.url).toBe(BUILT_IN);
      // The flag the report uses to say whose merchant this verdict is about.
      expect(decision.builtIn).toBe(true);
    }
  });

  it("accepts a real third-party catalogue and marks it as not built in", () => {
    const decision = resolveMerchantEndpoint(
      "https://shop.example.com/graphql",
      BUILT_IN,
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.url).toContain("shop.example.com/graphql");
    expect(decision.builtIn).toBe(false);
  });
});

describe("addresses that are refused", () => {
  /**
   * The metadata service is the first thing an SSRF probe reaches for, because on every major
   * cloud it hands instance credentials to anything that can make an HTTP request.
   */
  it("refuses cloud metadata services", () => {
    for (const host of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://100.100.100.100/latest/meta-data/",
    ]) {
      const decision = validateMerchantEndpoint(host);

      expect(decision.ok).toBe(false);
      if (decision.ok) return;
      expect(decision.reason).toMatch(/metadata|private or link-local/i);
    }
  });

  it("refuses private and link-local networks", () => {
    for (const host of [
      "http://10.0.0.5/graphql",
      "http://192.168.1.1/graphql",
      "http://172.16.0.1/graphql",
      "http://172.31.255.254/graphql",
      "http://169.254.10.10/graphql",
      "http://[fd00::1]/graphql",
      "http://[fe80::1]/graphql",
    ]) {
      const decision = validateMerchantEndpoint(host);

      expect(decision.ok, `${host} should be refused`).toBe(false);
    }
  });

  /** 172.32 is public; the private block stops at 172.31. An over-broad regex would refuse it. */
  it("does not refuse public addresses that merely look private", () => {
    for (const host of [
      "https://172.32.0.1/graphql",
      "https://172.15.0.1/graphql",
      "https://11.0.0.1/graphql",
      "https://193.168.1.1/graphql",
    ]) {
      const decision = validateMerchantEndpoint(host);

      expect(decision.ok, `${host} should be allowed`).toBe(true);
    }
  });

  it("refuses schemes that only appear in SSRF payloads", () => {
    for (const bad of [
      "file:///etc/passwd",
      "gopher://127.0.0.1:11211/_stats",
      "ftp://shop.example/graphql",
      "data:text/plain,hello",
    ]) {
      const decision = validateMerchantEndpoint(bad);

      expect(decision.ok, `${bad} should be refused`).toBe(false);
      if (decision.ok) return;
      expect(decision.reason).toMatch(/not supported|not a URL/i);
    }
  });

  /**
   * Credentials in the URL would be copied into the run log and the audit trail, which are
   * both written to disk and rendered in a browser.
   */
  it("refuses credentials embedded in the URL", () => {
    const decision = validateMerchantEndpoint(
      "https://admin:hunter2@shop.example/graphql",
    );

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toContain("credentials");
  });

  it("explains what is wrong rather than refusing blankly", () => {
    const decision = validateMerchantEndpoint("shop.example/graphql");

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    // Naming the missing scheme is the difference between a fixable error and a dead end.
    expect(decision.reason).toContain("scheme");
  });
});

describe("loopback, allowed deliberately", () => {
  /**
   * Not an oversight. The built-in merchant runs on loopback and so does local development, so
   * blocking it would break the default path in the name of protecting it. The exposure is
   * narrow — the caller can reach the machine already serving them this page — while private
   * *networks*, where the interesting internal targets live, stay blocked.
   */
  it("accepts localhost and the whole 127/8 range", () => {
    for (const host of [
      "http://localhost:3000/api/merchant/nordwell",
      "http://127.0.0.1:3000/graphql",
      "http://127.1.2.3:8080/graphql",
      "http://[::1]:3000/graphql",
    ]) {
      const decision = validateMerchantEndpoint(host);

      expect(decision.ok, `${host} should be allowed`).toBe(true);
    }
  });
});
