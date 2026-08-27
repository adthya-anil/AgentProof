import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { stableHash } from "../core/ids.js";
import { type Policy, parsePolicy } from "./schema.js";

export const DEFAULT_POLICY_PATH = "policies/hamperhub-v1.yaml";

export function loadPolicyFromFile(path = DEFAULT_POLICY_PATH): Policy {
  const absolute = resolve(process.cwd(), path);
  const raw = readFileSync(absolute, "utf8");
  return parsePolicy(parseYaml(raw));
}

export function loadPolicyFromYaml(yaml: string): Policy {
  return parsePolicy(parseYaml(yaml));
}

/**
 * Content-addressed policy version.
 *
 * Quotes and approval receipts record this string, so if the merchant edits
 * their policy mid-flight an in-progress approval is detectably bound to the
 * older ruleset rather than silently re-interpreted under the new one.
 */
export function policyVersion(policy: Policy): string {
  return `${policy.policyId}@${stableHash(policy.source).slice(0, 12)}`;
}
