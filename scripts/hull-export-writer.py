#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def _emit(payload: dict) -> None:
    print(json.dumps(payload, separators=(",", ":")))


def _write_xdmf(
    xdmf_path: Path,
    h5_name: str,
    dims_zyx: tuple[int, int, int],
    origin_xyz: tuple[float, float, float],
    spacing_xyz: tuple[float, float, float],
    field_names: list[str],
) -> None:
    nz, ny, nx = dims_zyx
    ox, oy, oz = origin_xyz
    dx, dy, dz = spacing_xyz
    origin_zyx = (oz, oy, ox)
    spacing_zyx = (dz, dy, dx)
    dims_text = f"{nz} {ny} {nx}"
    origin_text = f"{origin_zyx[0]} {origin_zyx[1]} {origin_zyx[2]}"
    spacing_text = f"{spacing_zyx[0]} {spacing_zyx[1]} {spacing_zyx[2]}"

    lines: list[str] = [
        "<?xml version=\"1.0\" ?>",
        "<!DOCTYPE Xdmf SYSTEM \"Xdmf.dtd\" []>",
        "<Xdmf Version=\"3.0\">",
        "  <Domain>",
        "    <Grid Name=\"nhm2_export\" GridType=\"Uniform\">",
        f"      <Topology TopologyType=\"3DCoRectMesh\" Dimensions=\"{dims_text}\"/>",
        "      <Geometry GeometryType=\"ORIGIN_DXDYDZ\">",
        f"        <DataItem Dimensions=\"3\" NumberType=\"Float\" Precision=\"8\" Format=\"XML\">{origin_text}</DataItem>",
        f"        <DataItem Dimensions=\"3\" NumberType=\"Float\" Precision=\"8\" Format=\"XML\">{spacing_text}</DataItem>",
        "      </Geometry>",
    ]
    for name in field_names:
        lines.extend(
            [
                f"      <Attribute Name=\"{name}\" AttributeType=\"Scalar\" Center=\"Cell\">",
                f"        <DataItem Dimensions=\"{dims_text}\" NumberType=\"Float\" Precision=\"4\" Format=\"HDF\">{h5_name}:/fields/{name}</DataItem>",
                "      </Attribute>",
            ]
        )
    lines.extend(
        [
            "    </Grid>",
            "  </Domain>",
            "</Xdmf>",
            "",
        ]
    )
    xdmf_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Write NHM2 scientific HDF5/XDMF dataset from manifest.")
    parser.add_argument("--manifest", required=True, help="Path to writer-manifest.json")
    args = parser.parse_args()

    try:
        import h5py  # type: ignore
        import numpy as np  # type: ignore
    except Exception as exc:  # pragma: no cover - runtime dependency path
        _emit(
            {
                "ok": False,
                "error": "hdf5_dependency_missing",
                "message": str(exc),
            }
        )
        return

    try:
        manifest_path = Path(args.manifest).resolve()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        output = manifest.get("output", {})
        dataset_h5_path = Path(output.get("dataset_h5", "")).resolve()
        dataset_xdmf_path = Path(output.get("dataset_xdmf", "")).resolve()
        fields = manifest.get("fields", [])
        coordinate = manifest.get("coordinate", {})
        dims_xyz = coordinate.get("dims_xyz", [1, 1, 1])
        spacing_xyz = coordinate.get("spacing_xyz", [1.0, 1.0, 1.0])
        origin_xyz = coordinate.get("origin_xyz", [0.0, 0.0, 0.0])

        nx = max(1, int(dims_xyz[0]))
        ny = max(1, int(dims_xyz[1]))
        nz = max(1, int(dims_xyz[2]))
        dims_zyx = (nz, ny, nx)
        dx = float(spacing_xyz[0])
        dy = float(spacing_xyz[1])
        dz = float(spacing_xyz[2])
        ox = float(origin_xyz[0])
        oy = float(origin_xyz[1])
        oz = float(origin_xyz[2])

        dataset_h5_path.parent.mkdir(parents=True, exist_ok=True)
        dataset_xdmf_path.parent.mkdir(parents=True, exist_ok=True)

        with h5py.File(dataset_h5_path, "w") as h5f:
            h5f.attrs["storage_order"] = "zyx"
            h5f.attrs["dims_xyz"] = [nx, ny, nz]
            h5f.attrs["origin_xyz"] = [ox, oy, oz]
            h5f.attrs["spacing_xyz"] = [dx, dy, dz]
            fields_group = h5f.create_group("fields")

            for field in fields:
                name = str(field.get("name", "")).strip()
                raw_path = Path(str(field.get("raw_path", ""))).resolve()
                shape_zyx = field.get("shape_zyx", [nz, ny, nx])
                if not name:
                    continue
                if not raw_path.exists():
                    raise RuntimeError(f"raw_field_missing:{name}:{raw_path}")
                z = int(shape_zyx[0]) if len(shape_zyx) > 0 else nz
                y = int(shape_zyx[1]) if len(shape_zyx) > 1 else ny
                x = int(shape_zyx[2]) if len(shape_zyx) > 2 else nx
                expected = z * y * x
                arr = np.fromfile(raw_path, dtype=np.float32)
                if arr.size != expected:
                    raise RuntimeError(
                        f"raw_field_size_mismatch:{name}:expected={expected}:actual={arr.size}"
                    )
                arr = arr.reshape((z, y, x))
                fields_group.create_dataset(
                    name,
                    data=arr,
                    compression="gzip",
                    shuffle=True,
                )

        h5_name = dataset_h5_path.name
        field_names = [str(field.get("name", "")).strip() for field in fields if str(field.get("name", "")).strip()]
        _write_xdmf(
            dataset_xdmf_path,
            h5_name,
            dims_zyx,
            (ox, oy, oz),
            (dx, dy, dz),
            field_names,
        )

        _emit(
            {
                "ok": True,
                "dataset_h5": str(dataset_h5_path),
                "dataset_xdmf": str(dataset_xdmf_path),
                "field_count": len(field_names),
            }
        )
    except Exception as exc:  # pragma: no cover - defensive path
        _emit({"ok": False, "error": "writer_exception", "message": str(exc)})


if __name__ == "__main__":
    main()

