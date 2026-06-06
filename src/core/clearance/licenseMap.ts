import type { LicenseType, RightsConfidence } from '../../types.js';

/**
 * The structured `basis` for a single clearance determination. Shape is normative
 * (schema-enforced): `rule`, `inputs`, and `summary` are all required —
 * honesty-by-architecture. A determination that cannot name its rule, cite its
 * inputs, and state its reasoning is not a valid determination.
 *
 * `rule` is a stable id that resolves as a fragment under the rule registry:
 * `https://openclearance.org/v0.1/rules#<rule>`. The set of ids is OPEN, not a
 * closed enum — an unrecognised id yields a non-fatal `unrecognised_rule`
 * advisory at verification time, never a schema rejection. See
 * `spec/clearance/v0.1/rules.md`.
 */
export interface ClearanceBasis {
  rule: string;
  inputs: { field: string; value: unknown }[];
  summary: string;
}

export interface ClearanceDecision {
  statement: string | null;
  commercialReproduction: { permitted: boolean; basis: ClearanceBasis };
  derivatives: { permitted: boolean; basis: ClearanceBasis };
  attributionRequired: { required: boolean; basis: ClearanceBasis };
  confidence: RightsConfidence;
}

// The ONLY place clearance determinations live. Fail-closed: a license type not
// listed here resolves to all-false / default-deny. Adding a recognised
// permissive license later is a single entry here + a rule-registry row + a test.
const PERMISSIVE: Partial<
  Record<LicenseType, { statement: string; rulePrefix: string; summaryNoun: string }>
> = {
  CC0: {
    statement: 'https://creativecommons.org/publicdomain/zero/1.0/',
    rulePrefix: 'cc0',
    summaryNoun: 'CC0 public-domain dedication',
  },
  // The gate only emits type=PD for the worldwide Creative Commons Public
  // Domain Mark (Europeana `rights` = .../publicdomain/mark/1.0/) and the
  // Wikimedia PD/PDM templates — never a jurisdiction-scoped rightsstatements.org
  // value. The Public Domain Mark URI is therefore the accurate, gate-aligned
  // statement; the old US-scoped NoC-US URI claimed a narrower (and incorrect)
  // scope the gate never asserts.
  PD: {
    statement: 'https://creativecommons.org/publicdomain/mark/1.0/',
    rulePrefix: 'pd',
    summaryNoun: 'Public Domain Mark status',
  },
};

export function clearanceForLicense(type: LicenseType): ClearanceDecision {
  const ok = PERMISSIVE[type];
  const inputs = [{ field: 'license.type', value: type }];

  if (ok) {
    return {
      statement: ok.statement,
      commercialReproduction: {
        permitted: true,
        basis: {
          rule: `${ok.rulePrefix}-grants-commercial`,
          inputs,
          summary: `${ok.summaryNoun} permits all uses, including commercial.`,
        },
      },
      derivatives: {
        permitted: true,
        basis: {
          rule: `${ok.rulePrefix}-grants-derivatives`,
          inputs,
          summary: `${ok.summaryNoun} permits modification and derivative works.`,
        },
      },
      attributionRequired: {
        required: false,
        basis: {
          rule: `${ok.rulePrefix}-waives-attribution`,
          inputs,
          summary: `${ok.summaryNoun} requires no attribution as a condition of reuse.`,
        },
      },
      confidence: 'high',
    };
  }

  const denyBasis: ClearanceBasis = {
    rule: 'default-deny',
    inputs,
    summary: `unrecognized or non-permissive license type '${type}' ⇒ default deny`,
  };
  return {
    statement: null,
    commercialReproduction: { permitted: false, basis: denyBasis },
    derivatives: { permitted: false, basis: denyBasis },
    attributionRequired: { required: false, basis: denyBasis },
    confidence: 'low',
  };
}
