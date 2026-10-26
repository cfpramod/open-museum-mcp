// Compiled by the package typecheck script, through tests/types/tsconfig.json.
// Every string field of Artwork must be either cleaned by the final pass or
// exempt with a reason. A field in neither list, in both, or listed but gone
// makes the matching line fail to compile, and the error names the path.

import type { Artwork } from '../../src/types.js';
import type { CLEANED_PATHS, EXEMPT_PATHS, StringPaths } from '../helpers/artwork.js';

type Cleaned = (typeof CLEANED_PATHS)[number];
type Exempt = keyof typeof EXEMPT_PATHS;
type Paths = StringPaths<Artwork>;
type NoneOr<T> = [T] extends [never] ? 'none' : T;

export const unclassified: NoneOr<Exclude<Paths, Cleaned | Exempt>> = 'none';
export const listedButGone: NoneOr<Exclude<Cleaned | Exempt, Paths>> = 'none';
export const cleanedAndExempt: NoneOr<Extract<Cleaned, Exempt>> = 'none';
