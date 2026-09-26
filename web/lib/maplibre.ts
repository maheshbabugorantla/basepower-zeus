import * as maplibregl from "maplibre-gl";

// See scripts/copy-maplibre-worker.mjs: the worker is served from public/
// because the bundler does not emit it. Without this, maps render blank.
if (typeof window !== "undefined") {
  maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
}

export { maplibregl };
