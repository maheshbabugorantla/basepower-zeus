// Presentation helpers for ranked-home rows (ranking rail, map card).
// Display only: the raw CAD values stay untouched in the data and the CSV
// export; these only change how a row reads on screen.

import type { SignalName } from "../components/ui/Chip";

// Road-type and route abbreviations CAD rolls use that should stay capitalised.
const KEEP_UPPER = new Set(["FM", "RM", "RR", "IH", "US", "SH", "CR", "HWY", "PR", "NE", "NW", "SE", "SW", "II", "III", "IV", "LLC"]);

/** "3901 WATERSEDGE" -> "3901 Watersedge"; "4501 FM 1826" -> "4501 FM 1826"; "2ND" -> "2nd". */
export function titleCaseAddress(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((word) => {
      if (!word.trim() || word === "-" || word === "/") return word;
      const upper = word.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      if (/^\d+(st|nd|rd|th)$/.test(word)) return word; // ordinals stay lower-case after the digits
      if (/^\d/.test(word)) return upper; // unit numbers like "12B"
      if (word.startsWith("mc") && word.length > 2) return "Mc" + word.charAt(2).toUpperCase() + word.slice(3);
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join("");
}

/** Street line only ("3901 Watersedge"); the city goes on the meta line. */
export function streetLine(situsNum: string | null, situsStreet: string | null): string {
  return titleCaseAddress([situsNum, situsStreet].filter(Boolean).join(" "));
}

/** "Austin 78731 · built 2024 · Austin Energy" -- only the parts that exist. */
export function homeMetaLine(parts: {
  city: string | null;
  zip: string | null;
  yrBuilt?: number | null;
  utility?: string | null;
}): string {
  const place = [titleCaseAddress(parts.city), parts.zip].filter(Boolean).join(" ");
  return [place || null, parts.yrBuilt ? `built ${parts.yrBuilt}` : null, parts.utility || null].filter(Boolean).join(" · ");
}

// Model reason labels (core.home_propensity.reasons[].feature, lower-cased)
// -> the DESIGN.md signal family whose colour the reason chip carries. Same
// families REASON_META assigns the weighted-mode signal keys.
const REASON_SIGNAL: Record<string, SignalName> = {
  "outage exposure": "outage",
  "home value": "grid",
  "over-65 exemption on file": "household",
  "share of neighbors 65+": "household",
  "share of neighbors with electric heat": "household",
  "medical-need rate (zip)": "household",
  "share of neighbors earning $100k+": "household",
  "share of neighbors aged 35-64": "household",
  "home's own solar permit": "install",
  "home's own ev charger permit": "install",
  "home's own panel-upgrade permit": "install",
  "neighbors who already added backup": "install",
};

export function reasonSignal(featureLabel: string): SignalName {
  return REASON_SIGNAL[featureLabel.toLowerCase()] ?? "install";
}

// Short appraisal-district names for one-line source notes.
export const CAD_SHORT: Record<string, string> = {
  "48453": "Travis CAD",
  "48201": "HCAD",
  "48491": "WCAD",
};

/** The dataset behind each score signal, for the one-line "N sources" note
 * under a case sentence. Keyed by the breakdown's signal key. */
export function signalSource(key: string, cadShort: string): string | null {
  switch (key) {
    case "outage":
      return "EIA-861";
    case "backup_intent":
    case "home_permits":
    case "permit_risk":
      return "Austin permits";
    case "installability":
    case "home_value":
    case "owner_65":
      return cadShort;
    case "income_100k":
    case "age_35_64":
    case "age65":
    case "electric_heat":
      return "ACS 2024";
    case "empower":
      return "HHS emPOWER";
    case "flood":
      return "FEMA flood maps";
    default:
      return null;
  }
}
