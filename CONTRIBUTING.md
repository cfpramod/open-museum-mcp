# Contributing

Thanks for your interest. The most valuable contributions are new museum adapters and refinements to the verification rules and date parser.

## Adding a museum adapter

Walk-through using a hypothetical museum with code `xyz`:

### 1. Implement the fetcher

Create `src/fetchers/xyz.ts`:

```ts
import { parseDisplayDate } from '../dateParser.js';
import { validateXyzLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import type { Artwork, ValidationResult } from '../types.js';
import type { Fetcher } from './types.js';

const XYZ_API = 'https://api.xyzmuseum.org/v1';

export const xyzFetcher: Fetcher = {
  code: 'xyz',
  name: 'XYZ Museum',

  async search(query, limit) { /* return ['xyz:123', ...] */ },
  async getRaw(id) { /* return raw API response */ },
  normalize(raw): ValidationResult { /* rights gate, then map */ },
};
```

### 2. Add the license validator

In `src/licenseGate.ts`:

```ts
export const validateXyzLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') return reject('xyz: ...');
  const obj = raw as Record<string, unknown>;
  if (obj.rights_status === 'open') {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: 'open',
        verificationSource: 'xyz.rights_status',
        verifiedAt: new Date().toISOString(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'xyz: rights_status=open',
    };
  }
  return reject(`xyz: rights_status=${obj.rights_status} (strict default reject)`);
};
```

Then register in the `VALIDATORS` map at the bottom of the file.

**Strict-default rule.** If any rights field is missing, ambiguous, or unrecognized, the validator must reject. New museum rules should err strictly — when in doubt, write the test that proves the ambiguous record gets rejected, then write the validator. The discipline of this project is its main value; bugs that allow a non-open record through are P0 and outweigh false negatives.

**Two-tier rights models.** If a museum's rights model is genuinely two-tier (e.g. metadata open, images restricted), set `imageOpenAccess: false` and `metadataOpenAccess: true` rather than rejecting outright. Add a comment in the validator explaining the museum's published distinction so future maintainers understand the asymmetry.

**`rawSnapshot` on rejected records.** The `RejectedArtwork.rawSnapshot` field is intentionally typed as `unknown` and preserved verbatim. It exists for two reasons: debugging when a museum quietly changes a field name (the snapshot tells you what they actually returned), and authoring fixtures (copy a real rejection into `tests/fixtures/` to lock the behaviour). Don't strip or transform it.

### 3. Extend the mappings

If the museum introduces regions or periods not yet mapped:

- `src/data/regions.json` — add aliases under the canonical key.
- `src/data/dynasties.json` — add new period entries with `[start, end]` year ranges. Use signed integers for BCE.

### 4. Write tests

Create `tests/xyz.test.ts` and at least three fixture files in `tests/fixtures/`:

- `xyz-accepted.json` — a representative open-access record.
- `xyz-rejected-restricted.json` — a record where rights are explicitly closed.
- `xyz-rejected-missing-field.json` — a record where the rights field is absent (must hit strict-default reject).

The `accepted` test should verify: id format, `imageOpenAccess`, `metadataOpenAccess`, `license.type`, `license.verificationSource`, `license.confidence`, region normalization, and date parsing.

### 5. Register the adapter

In `src/server.ts`:

```ts
import { xyzFetcher } from './fetchers/xyz.js';

const FETCHERS: Record<string, Fetcher> = {
  [metFetcher.code]: metFetcher,
  [xyzFetcher.code]: xyzFetcher,
};
```

### 6. Update the README

- Add the museum to the "Supported museums" table.
- Add a row to the "Verification model" table.

## Code conventions

- TypeScript strict mode is on. Don't suppress errors with `any`; if a field's shape is uncertain, type it as `unknown` and narrow with explicit checks.
- ESM only (`.js` extensions in import paths even for `.ts` source).
- Tests use Vitest with fixture files. No live API calls in tests.
- Keep adapters dependency-free beyond `node:fetch`. The repo deliberately does not pull in axios or HTTP wrappers.

## Running locally

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev   # runs the MCP server via tsx
```

## Reporting issues

If you find a record that the gate accepts when it shouldn't (or vice versa), open an issue with the artwork ID and the museum's raw API response. License correctness is the most important property of this project; bugs there are P0.
