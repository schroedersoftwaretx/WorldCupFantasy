/**
 * National-team flags as IMAGES (not emoji).
 *
 * We previously rendered flags using Unicode regional-indicator emoji (e.g.
 * "\u{1F1EB}\u{1F1F7}" for France). That fails on Windows: Chrome/Edge/Firefox
 * on Windows do NOT render regional-indicator pairs as flags — they show the
 * two-letter country code instead ("FR"). To get flags that display
 * consistently on every platform we render a small <img> served by flagcdn.com,
 * keyed by the country's flagcdn code.
 *
 * Maps the `national_team` names stored in the DB (full English country names
 * like "France", "South Korea") to a flagcdn code. Most are the lower-cased
 * ISO 3166-1 alpha-2 code; the UK home nations use flagcdn's subdivision codes
 * (gb-eng, gb-sct, gb-wls, gb-nir).
 *
 * `flagCode()` returns "" for an unknown name, so callers can fall back to
 * showing just the name with no flag.
 */

/** Country name (lowercased, trimmed) -> flagcdn code. */
const NAME_TO_CODE: Record<string, string> = {
  argentina: "ar",
  australia: "au",
  austria: "at",
  belgium: "be",
  brazil: "br",
  cameroon: "cm",
  canada: "ca",
  chile: "cl",
  colombia: "co",
  "costa rica": "cr",
  "cote d'ivoire": "ci",
  "côte d'ivoire": "ci",
  "ivory coast": "ci",
  croatia: "hr",
  denmark: "dk",
  ecuador: "ec",
  egypt: "eg",
  france: "fr",
  germany: "de",
  ghana: "gh",
  greece: "gr",
  honduras: "hn",
  iran: "ir",
  "ir iran": "ir",
  iraq: "iq",
  italy: "it",
  jamaica: "jm",
  japan: "jp",
  "korea republic": "kr",
  "south korea": "kr",
  "north korea": "kp",
  mexico: "mx",
  morocco: "ma",
  netherlands: "nl",
  "new zealand": "nz",
  nigeria: "ng",
  norway: "no",
  panama: "pa",
  paraguay: "py",
  peru: "pe",
  poland: "pl",
  portugal: "pt",
  qatar: "qa",
  "republic of ireland": "ie",
  ireland: "ie",
  "saudi arabia": "sa",
  senegal: "sn",
  serbia: "rs",
  slovakia: "sk",
  slovenia: "si",
  "south africa": "za",
  spain: "es",
  sweden: "se",
  switzerland: "ch",
  tunisia: "tn",
  turkey: "tr",
  "türkiye": "tr",
  "united states": "us",
  "united states of america": "us",
  usa: "us",
  uruguay: "uy",
  uzbekistan: "uz",
  venezuela: "ve",
  "cape verde": "cv",
  "cabo verde": "cv",
  algeria: "dz",
  jordan: "jo",
  "dr congo": "cd",
  "democratic republic of the congo": "cd",
  bolivia: "bo",
  ukraine: "ua",
  wales: "gb-wls",
  england: "gb-eng",
  scotland: "gb-sct",
  "northern ireland": "gb-nir",
};

/**
 * flagcdn code for a national-team name, or "" if unknown. Matching is case-
 * and whitespace-insensitive.
 */
export function flagCode(nationalTeam: string | null | undefined): string {
  if (!nationalTeam) return "";
  return NAME_TO_CODE[nationalTeam.trim().toLowerCase()] ?? "";
}

/** PNG flag URL at a given pixel width (flagcdn widths: 20, 40, 80, ...). */
export function flagUrl(code: string, width: 20 | 40 | 80 = 20): string {
  return `https://flagcdn.com/w${width}/${code}.png`;
}

/** Props for a 1x/2x flag <img>. Returns null when the country is unknown. */
export function flagImg(
  nationalTeam: string | null | undefined,
): { src: string; srcSet: string } | null {
  const code = flagCode(nationalTeam);
  if (!code) return null;
  return {
    src: flagUrl(code, 20),
    srcSet: `${flagUrl(code, 40)} 2x`,
  };
}
