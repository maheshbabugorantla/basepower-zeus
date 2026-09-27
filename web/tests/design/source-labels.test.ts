import { describe, expect, it } from "vitest";
import { describeParamValue, fileFact, sourceFileName } from "../../lib/sourceLabels";

// The urls below are the manifest's own source urls (api.sources.url) for
// files that share a dataset name on the Sources page.

describe("sourceFileName", () => {
  it("keeps the parent of a generic endpoint so same-named files differ", () => {
    expect(sourceFileName("https://data.wcad.org/api/views/ij43-xknu/rows.csv?accessType=DOWNLOAD")).toBe("ij43-xknu/rows.csv");
    expect(sourceFileName("https://ndownloader.figshare.com/files/53581661")).toBe("files/53581661");
  });

  it("names an ArcGIS query by its service", () => {
    expect(sourceFileName("https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0/query")).toBe("HCAD/Parcels");
  });

  it("decodes file names and keeps the release suffix", () => {
    expect(sourceFileName("https://www.eia.gov/electricity/data/eia861/zip/f8612025er.zip")).toBe("f8612025er.zip");
    expect(
      sourceFileName("https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip")
    ).toBe("2026 Certified Appraisal Export Supp 0_07182026.zip");
  });
});

describe("describeParamValue", () => {
  it("names the county in a Census geography filter", () => {
    expect(describeParamValue("state:48 county:453")).toBe("Travis County");
    expect(describeParamValue("LZ_AEN")).toBe("LZ_AEN");
  });
});

describe("fileFact", () => {
  it("names what a same-named file actually is", () => {
    expect(fileFact("https://ndownloader.figshare.com/files/53581661")).toBe("2024 outages");
    expect(fileFact("https://data.wcad.org/api/views/nbn7-h4pp/rows.csv?accessType=DOWNLOAD")).toBe("Exemptions");
    expect(fileFact("https://www.eia.gov/electricity/data/eia861/zip/f8612025er.zip")).toBe("2025 early release");
  });
});
