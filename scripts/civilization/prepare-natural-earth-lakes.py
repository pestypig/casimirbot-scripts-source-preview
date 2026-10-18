"""Convert a SHA-pinned Natural Earth 1:50m lakes archive to a map evidence asset.

Requires pyshp 2.3.1. The polygons are generalized source depictions, not current
shorelines, hydrological measurements, or a legal/engineering constraint screen.
"""

import hashlib
import io
import json
import math
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import shapefile


ROOT = Path.cwd()
ARCHIVE = ROOT / ".cache/civilization/source-archives/ne_50m_lakes.zip"
OUTPUT = ROOT / "server/assets/civilization/natural-earth-50m-lakes-v5.0.0.json"
EXPECTED_SHA256 = "f28d42c286d96b57a17aac2cbeb432f8c65532c20063495711fbc64e24666df3"
SOURCE_URL = "https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_lakes.zip"
PREFIX = "ne_50m_lakes"

data = ARCHIVE.read_bytes()
if hashlib.sha256(data).hexdigest() != EXPECTED_SHA256:
    raise SystemExit("Natural Earth lakes archive hash differs from reviewed acquisition")

with zipfile.ZipFile(io.BytesIO(data)) as archive:
    version = archive.read(f"{PREFIX}.VERSION.txt").decode("ascii").strip()
    if version != "5.0.0":
        raise SystemExit(f"Unexpected Natural Earth lakes version: {version}")
    reader = shapefile.Reader(
        shp=io.BytesIO(archive.read(f"{PREFIX}.shp")),
        shx=io.BytesIO(archive.read(f"{PREFIX}.shx")),
        dbf=io.BytesIO(archive.read(f"{PREFIX}.dbf")),
    )
    features = []
    for item in reader.iterShapeRecords():
        record = item.record.as_dict()
        geometry = item.shape.__geo_interface__
        if geometry["type"] not in ("Polygon", "MultiPolygon"):
            raise SystemExit(f"Unexpected geometry for lake {record['ne_id']}")
        points = item.shape.points
        if not points or not all(math.isfinite(value) for point in points for value in point[:2]):
            raise SystemExit(f"Invalid lake geometry for {record['ne_id']}")
        features.append({
            "id": int(record["ne_id"]),
            "name": record["name"] or None,
            "nameEn": record["name_en"] or None,
            "featureClass": record["featurecla"],
            "scaleRank": int(record["scalerank"]),
            "minZoom": float(record["min_zoom"]),
            "bbox": [round(min(point[0] for point in points), 6),
                     round(min(point[1] for point in points), 6),
                     round(max(point[0] for point in points), 6),
                     round(max(point[1] for point in points), 6)],
            "geometry": geometry,
        })

payload = {
    "schemaVersion": "civilization_natural_earth_lakes_source/v1",
    "datasetId": PREFIX,
    "datasetVersion": version,
    "sourceArchiveUrl": SOURCE_URL,
    "sourceArchiveSha256": EXPECTED_SHA256,
    "sourcePageUrl": "https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-lakes-reservoirs/",
    "licenseUrl": "https://www.naturalearthdata.com/about/terms-of-use/",
    "acquiredAt": datetime.now(timezone.utc).date().isoformat(),
    "interpretationLimits": [
        "Generalized 1:50m cartography; source-effective shoreline dates are not supplied.",
        "Natural Earth warns its Aral Sea outline may be larger than current extent.",
        "Lake geometry does not measure water level, ecology, navigability, rights, or route feasibility.",
    ],
    "features": features,
}
OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"Wrote {len(features)} lake depictions to {OUTPUT}")
