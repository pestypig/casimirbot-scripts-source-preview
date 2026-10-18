"""Create local, unreviewed OCR candidates for one acquired UNGA81 PDF."""

import argparse
import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import fitz
from rapidocr_onnxruntime import RapidOCR


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("--source-url", required=True)
parser.add_argument("--max-pages", type=int, default=20)
args = parser.parse_args()
if not 1 <= args.max_pages <= 30:
    raise SystemExit("max-pages must be between 1 and 30")

root = Path.cwd()
manifest = json.loads((root / "server/assets/civilization/unga81-submitted-pdf-manifest.v1.json").read_text(encoding="utf-8"))
source = next((entry for entry in manifest["entries"] if entry["sourceUrl"] == args.source_url), None)
if source is None or source["status"] != "available":
    raise SystemExit("source URL is not an acquired manifest PDF")
text_id = sha256(args.source_url.encode("utf-8"))[:20]
pdf_path = root / ".cache/civilization/unga81-submitted-pdfs" / f"{text_id}.pdf"
pdf_bytes = pdf_path.read_bytes()
if sha256(pdf_bytes) != source["pdfSha256"]:
    raise SystemExit("local PDF hash does not match acquisition manifest")

document = fitz.open(stream=pdf_bytes, filetype="pdf")
if document.page_count > args.max_pages:
    raise SystemExit(f"PDF has {document.page_count} pages, above requested bound")
engine = RapidOCR()
pages = []
with tempfile.TemporaryDirectory(prefix="unga81-ocr-") as temp_dir:
    image_path = Path(temp_dir) / "page.png"
    for page_index in range(document.page_count):
        pixmap = document[page_index].get_pixmap(matrix=fitz.Matrix(1.8, 1.8), alpha=False)
        pixmap.save(image_path)
        result, _ = engine(str(image_path))
        lines = [{"text": str(row[1]), "confidence": round(float(row[2]), 4)} for row in (result or [])]
        pages.append({"page": page_index + 1, "lines": lines,
                      "meanConfidence": round(sum(line["confidence"] for line in lines) / len(lines), 4) if lines else None})

ocr_text = "\f".join("\n".join(line["text"] for line in page["lines"]) for page in pages)
payload = {
    "schemaVersion": "civilization_unga81_local_ocr_candidate/v1",
    "sourceUrl": args.source_url,
    "countryIso3": source["countryIso3"],
    "sourcePdfSha256": source["pdfSha256"],
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "engine": "rapidocr_onnxruntime",
    "status": "unreviewed_ocr_candidate",
    "interpretationLimit": "OCR may misread, omit, or reorder text. Inspect each cited PDF page; do not publish this text as a verified statement or country position.",
    "pageCount": document.page_count,
    "ocrTextSha256": sha256(ocr_text.encode("utf-8")),
    "pages": pages,
}
out_dir = root / ".cache/civilization/unga81-ocr"
out_dir.mkdir(parents=True, exist_ok=True)
out_path = out_dir / f"{text_id}.json"
out_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"{out_path}: {document.page_count} pages, {sum(len(page['lines']) for page in pages)} OCR lines; review required")
