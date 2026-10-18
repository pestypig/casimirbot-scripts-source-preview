"""Prepare a bounded country-depiction candidate index from the acquired Natural Earth ZIP.

Requires pyshp 2.3.1 for preparation only; the application reads the JSON asset.
Bounding boxes over-include routes and never establish a border crossing.
"""

import hashlib
import io
import json
import math
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import shapefile


ROOT = Path.cwd()
ARCHIVE = ROOT / ".cache/civilization/natural-earth-50m-admin0/ne_50m_admin_0_countries.zip"
OUTPUT = ROOT / "server/assets/civilization/natural-earth-50m-country-bbox-index.v1.json"
GEOMETRY_OUTPUT = ROOT / "server/assets/civilization/natural-earth-50m-country-polygons.v1.json"
EXPECTED_SHA256 = "5fed433373581fa648920435f937d95f2d3c0200e067409c6478dcdf1b853139"
SOURCE_URL = "https://naturalearth.s3.amazonaws.com/50m_cultural/ne_50m_admin_0_countries.zip"
SOURCE_VERSION_ID = "bhlIScndAEsu5g_U2p9BdfKlok9hAcBp"
PREFIX = "ne_50m_admin_0_countries"

data = ARCHIVE.read_bytes()
if hashlib.sha256(data).hexdigest() != EXPECTED_SHA256:
    raise SystemExit("Natural Earth archive hash differs from the reviewed acquisition")

with zipfile.ZipFile(io.BytesIO(data)) as archive:
    version = archive.read(f"{PREFIX}.VERSION.txt").decode("ascii").strip()
    if version != "5.1.1":
        raise SystemExit(f"Unexpected Natural Earth version: {version}")
    reader = shapefile.Reader(
        shp=io.BytesIO(archive.read(f"{PREFIX}.shp")),
        shx=io.BytesIO(archive.read(f"{PREFIX}.shx")),
        dbf=io.BytesIO(archive.read(f"{PREFIX}.dbf")),
    )
    entries = []
    geometry_entries = []
    for item in reader.iterShapeRecords():
        record = item.record.as_dict()
        shape = item.shape
        code = str(record["ADM0_A3"]).strip()
        if len(code) != 3 or not code.isupper():
            raise SystemExit(f"Invalid editorial ADM0 code: {code!r}")
        boundaries = [*shape.parts, len(shape.points)]
        boxes = []
        for start, end in zip(boundaries, boundaries[1:]):
            points = shape.points[start:end]
            if not points:
                continue
            west = min(point[0] for point in points)
            east = max(point[0] for point in points)
            south = min(point[1] for point in points)
            north = max(point[1] for point in points)
            box = [round(value, 6) for value in (west, south, east, north)]
            if not all(math.isfinite(value) for value in box):
                raise SystemExit("Non-finite source geometry")
            boxes.append(box)
        if not boxes:
            raise SystemExit(f"No geometry for {code}")
        iso_code = str(record["ISO_A3"]).strip()
        entries.append({
            "editorialAdm0A3": code,
            "isoA3": iso_code if len(iso_code) == 3 and iso_code.isascii() and iso_code.isalpha() and iso_code.isupper() else None,
            "name": record["NAME"],
            "sourceFeatureId": str(record["NE_ID"]),
            "partBboxes": boxes,
        })
        geometry = shape.__geo_interface__
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        geometry_entries.append({
            "sourceFeatureId": str(record["NE_ID"]),
            "polygons": [[[[round(value, 6) for value in point] for point in ring]
                          for ring in polygon] for polygon in polygons],
        })

if len(entries) != 242:
    raise SystemExit(f"Expected 242 Natural Earth country depictions, found {len(entries)}")

asset = {
    "schemaVersion": "civilization_natural_earth_50m_country_bbox_index/v1",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "source": {
        "datasetId": PREFIX,
        "datasetVersion": version,
        "sourceUrl": SOURCE_URL,
        "sourceVersionId": SOURCE_VERSION_ID,
        "sourceArchiveSha256": EXPECTED_SHA256,
        "licenseId": "Public Domain",
        "licenseUrl": "https://www.naturalearthdata.com/about/terms-of-use/",
        "editorialPolicyUrl": "https://www.naturalearthdata.com/about/disputed-boundaries-policy/",
    },
    "method": "Bounding boxes of every polygon part in the acquired 1:50m country Shapefile. Intersection is an over-inclusive candidate screen, not polygon contact, legal border, effective control, or consent.",
    "entries": sorted(entries, key=lambda entry: (entry["editorialAdm0A3"], entry["name"])),
}
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(asset, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"{OUTPUT}: {len(entries)} depictions, {sum(len(entry['partBboxes']) for entry in entries)} part bounding boxes")
geometry_asset = {
    "schemaVersion": "civilization_natural_earth_50m_country_polygons/v1",
    "sourceArchiveSha256": EXPECTED_SHA256,
    "coordinateOrder": "longitude_latitude_wgs84",
    "entries": sorted(geometry_entries, key=lambda entry: entry["sourceFeatureId"]),
}
GEOMETRY_OUTPUT.write_text(json.dumps(geometry_asset, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"{GEOMETRY_OUTPUT}: {len(geometry_entries)} depicted features with Polygon/MultiPolygon rings")
