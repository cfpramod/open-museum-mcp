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
  obscurityScore?: number;
}

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

export interface Tradition {
  tag: string;
  label: string;
  coverage: Record<string, number>;
}
