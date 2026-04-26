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

export interface ArtworkImages {
  full: string;
  large?: string;
  thumbnail?: string;
}

export interface ArtworkSource {
  apiUrl: string;
  pageUrl: string;
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
  region: string | null;
  period: string | null;
  imageUrls: ArtworkImages;
  imageOpenAccess: boolean;
  metadataOpenAccess: boolean;
  license: ArtworkLicense;
  source: ArtworkSource;
  description?: string;
  rawTags?: string[];
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
