// MapLibre runs tile/GeoJSON work in an ES-module web worker that it locates
// relative to its own bundle. Next/Turbopack does not emit that file, so the
// map shell renders but no tiles or layers ever load ("Worker failed to
// load"). Copy the worker and the shared chunk it imports into public/ so
// lib/maplibre.ts can point setWorkerUrl at a URL that exists. Runs before
// dev and build so the copy always matches the installed maplibre-gl version.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const out = new URL("../public/maplibre/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(dist, f), join(out, f));
}
console.log(`copied maplibre worker files to ${out}`);
