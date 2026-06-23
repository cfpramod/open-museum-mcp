import type { ColorFamily, PaletteEntry } from './color/colorMath.js';
import type { MediumCategory } from './medium.js';

export type { ColorFamily, MediumCategory, PaletteEntry };

export type LicenseType = 'CC0' | 'PD' | 'CC-BY' | 'CC-BY-SA' | 'OTHER' | 'UNKNOWN';

export type AttributionType =
  | 'named'
  | 'anonymous'
  | 'workshop'
  | 'after'
  | 'attributed'
  | 'circle'
  | 'follower';

export interface Artist {
  name: string;
  nationality?: string;
  lifespan?: string;
  attributionType: AttributionType;
}

export type RightsConfidence = 'high' | 'medium' | 'low';

export interface ArtworkLicense {
  type: LicenseType;
  rawValue: string;
  verificationSource: string;
  verifiedAt: string;
  confidence: RightsConfidence;
}

/**
 * Print/archival master image — the largest asset the museum publishes, which
 * may be NON-DISPLAYABLE in a browser `<img>` (e.g. a multi-hundred-MB TIFF) or
 * simply too large for screen use. Distinct from `ArtworkImages.full`, which is
 * always a browser-renderable derivative. Present only when a master exists that
 * is genuinely larger than `full`; absent when `full` already is the maximum the
 * source offers (then `maxResolution` mirrors the `full` dims).
 */
export interface ArtworkMaster {
  url: string;
  width?: number;
  height?: number;
  /** MIME type, e.g. `image/tiff` or `image/jpeg`. Flags non-`<img>` masters. */
  format?: string;
  byteSize?: number;
}

export interface ArtworkImages {
  /** Browser-displayable image (safe for `<img>`). Always a renderable derivative. */
  full: string;
  large?: string;
  thumbnail?: string;
  /** Pixel width of the `full` (displayable) asset, when the museum publishes it. */
  width?: number;
  /** Pixel height of the `full` (displayable) asset, when the museum publishes it. */
  height?: number;
  /** Byte size of the `full` asset, when the museum publishes it. */
  byteSize?: number;
  /**
   * Print/archival master when it is strictly larger than `full` (e.g. Cleveland's
   * `_full.tif`). Absent when `full` already is the source maximum. See {@link ArtworkMaster}.
   */
  master?: ArtworkMaster;
  /**
   * TRUE maximum pixel dimensions available for this work, across `full` AND
   * `master`. The single field the OMA image-quality filter and calendar plate
   * selection should rank on — so consumers never under-rate a work by reading a
   * default-size derivative's dims. Absent only when the source publishes no
   * pixel dimensions at all (e.g. AIC's data API). Additive v0.13 field.
   */
  maxResolution?: { width: number; height: number };
}

export interface ArtworkSource {
  apiUrl: string;
  pageUrl: string;
  /**
   * Upstream original-source URL when the museum's record points beyond
   * itself. For Wikimedia Commons records, this is the originating museum
   * or archive (parsed from the `Credit` extmetadata field). When the
   * caller needs a higher-resolution canonical asset, this is where to
   * look first.
   */
  originalUrl?: string;
}

export interface MuseumRef {
  code: string;
  name: string;
  url: string;
}

export interface Artwork {
  id: string;
  museum: MuseumRef;
  title: string;
  artist: Artist;
  displayDate: string;
  yearStart: number | null;
  yearEnd: number | null;
  medium: string;
  /**
   * Raw `medium` normalized to a controlled vocabulary for faceting and
   * filtering. Always set by every adapter's `normalize` (strict `other`
   * fallback — never guessed). Distinct from `medium`, which keeps the museum's
   * verbatim display string (used in citations). Additive v0.8a field.
   */
  mediumCategory: MediumCategory;
  region: string | null;
  period: string | null;
  imageUrls: ArtworkImages;
  imageOpenAccess: boolean;
  metadataOpenAccess: boolean;
  license: ArtworkLicense;
  source: ArtworkSource;
  description?: string;
  rawTags?: string[];
  /**
   * Dominant colour as a `#rrggbb` hex. Set by Node-side colour enrichment when
   * available; absent on Workers / the `.mcpb` bundle / any sharp-less run
   * (enrichment fails open). Additive v0.8b field.
   */
  dominantColor?: string;
  /** Top ~5 palette colours with weights (0..1), most-dominant first. Additive v0.8b. */
  palette?: PaletteEntry[];
  /** Coarse colour-family bin (one of ~11) for faceting. Additive v0.8b. */
  colorFamily?: ColorFamily;
  /** Reserved for v1.0 artist-obscurity scoring across the federated corpus. Not yet populated by any fetcher. */
  obscurityScore?: number;
}

/**
 * `rawSnapshot` preserves the museum's verbatim response when a record is
 * rejected by the rights gate. It exists for two purposes only:
 *   1. Debugging when a museum quietly changes a field name; the snapshot
 *      shows what they actually returned.
 *   2. Authoring rejection fixtures by copying a real-world rejection into
 *      `tests/fixtures/`.
 * Never expose this on the wire to MCP clients — it can include arbitrary
 * museum payload contents that aren't meant for end users.
 */
export interface RejectedArtwork {
  id: string;
  museumCode: string;
  reason: string;
  rawSnapshot: unknown;
}

export type ValidationResult =
  | { status: 'accepted'; artwork: Artwork }
  | { status: 'rejected'; rejection: RejectedArtwork };

export interface DateRange {
  yearStart: number | null;
  yearEnd: number | null;
}

/**
 * One tradition tag (a normalized region or period) plus per-museum
 * coverage counts in the local cache. Emitted by the `list_traditions`
 * tool so callers can see where holdings are well-represented and where
 * they're sparse before searching.
 */
export interface Tradition {
  tag: string;
  label: string;
  coverage: Record<string, number>;
}
