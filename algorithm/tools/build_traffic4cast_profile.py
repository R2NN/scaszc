"""Compile genuine Traffic4cast 2021 Moscow HDF5 days into a compact profile.

This is an offline preparation tool. It needs h5py and NumPy, which are not
required by the routing service at runtime. The Moscow bounds and rotation
come from IARAI MeTS-10's published T4C_BBOXES, not guessed city limits.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import warnings
from datetime import date
from pathlib import Path

import h5py
import numpy as np


HEIGHT = 495
WIDTH = 436
BLOCK = 3
PROFILE_HEIGHT = (HEIGHT + BLOCK - 1) // BLOCK
PROFILE_WIDTH = (WIDTH + BLOCK - 1) // BLOCK
SOURCE_NAME = re.compile(r'^(\d{4}-\d{2}-\d{2})_MOSCOW_8ch\.h5$')
MOSCOW_BOUNDS = {'south': 55.506, 'north': 55.942,
                 'west': 37.358, 'east': 37.853}


def build_profile(source: Path, output: Path, year: int) -> dict[str, object]:
    """Aggregate measured volume-weighted speeds by weekday, hour and direction."""
    files = []
    for path in source.rglob('*_MOSCOW_8ch.h5'):
        match = SOURCE_NAME.fullmatch(path.name)
        if match and date.fromisoformat(match.group(1)).year == year:
            files.append((date.fromisoformat(match.group(1)), path))
    files.sort()
    if not files:
        raise ValueError(f'No genuine {year} MOSCOW Traffic4cast 2021 training HDF5 days in {source}')
    if len({day for day, _ in files}) != len(files):
        raise ValueError('Duplicate Moscow training dates in source tree')
    shape = (7, 24, PROFILE_HEIGHT, PROFILE_WIDTH, 4)
    speed_volume = np.zeros(shape, dtype=np.uint64)
    volume_total = np.zeros(shape, dtype=np.uint64)
    for day, path in files:
        with h5py.File(path, 'r') as handle:
            if 'array' not in handle:
                raise ValueError(f'Traffic4cast dataset key "array" is missing: {path}')
            array = handle['array']
            if array.shape not in ((1, 288, HEIGHT, WIDTH, 8), (288, HEIGHT, WIDTH, 8)):
                raise ValueError(f'Unexpected Traffic4cast 2021 shape {array.shape}: {path}')
            if array.dtype != np.dtype('uint8'):
                raise ValueError(f'Unexpected Traffic4cast dtype {array.dtype}: {path}')
            for hour in range(24):
                frames = array[0, hour * 12:(hour + 1) * 12] if array.ndim == 5 else array[hour * 12:(hour + 1) * 12]
                volumes = frames[..., 0::2].astype(np.uint32)
                speeds = frames[..., 1::2].astype(np.uint32)
                # The official data_layout.py orders channels NE, SE, SW, NW.
                padded = ((0, 0), (0, PROFILE_HEIGHT * BLOCK - HEIGHT),
                          (0, PROFILE_WIDTH * BLOCK - WIDTH), (0, 0))
                volumes = np.pad(volumes, padded)
                speeds = np.pad(speeds, padded)
                block_shape = (12, PROFILE_HEIGHT, BLOCK, PROFILE_WIDTH, BLOCK, 4)
                weights = volumes.reshape(block_shape).sum(axis=(0, 2, 4), dtype=np.uint64)
                weighted = (volumes * speeds).reshape(block_shape).sum(axis=(0, 2, 4), dtype=np.uint64)
                volume_total[day.weekday(), hour] += weights
                speed_volume[day.weekday(), hour] += weighted
    valid_speed = (volume_total > 0) & (speed_volume > 0)
    measured = np.divide(speed_volume, volume_total, out=np.zeros(shape, dtype=np.float32),
                         where=valid_speed)
    # 90th percentile of measured weekly-hourly speeds is an empirical
    # unobstructed reference for each cell and direction, not a guessed road speed.
    masked = np.where(valid_speed, measured, np.nan)
    with warnings.catch_warnings():
        warnings.filterwarnings('ignore', message='All-NaN slice encountered', category=RuntimeWarning)
        freeflow = np.nanpercentile(masked, 90, axis=(0, 1))
    reference = np.where(np.isfinite(freeflow) & (freeflow > 0), freeflow, 0)
    ratio = np.divide(measured, reference[None, None, ...],
                      out=np.zeros(shape, dtype=np.float32),
                      where=reference[None, None, ...] > 0)
    encoded = np.where(valid_speed,
                       np.rint(np.clip(ratio, 1 / 255, 1) * 255), 0).astype(np.uint8)
    binary = encoded.tobytes(order='C')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.with_suffix('.bin').write_bytes(binary)
    metadata: dict[str, object] = {
        'format': 'traffic4cast-2021-hourly-v1',
        'city': 'MOSCOW',
        'source_year': year,
        'source_days': len(files),
        'source_dates': [files[0][0].isoformat(), files[-1][0].isoformat()],
        'source': 'HERE / IARAI Traffic4cast 2021 MOSCOW dynamic 8-channel HDF5',
        'bounds': MOSCOW_BOUNDS,
        'rotated': True,
        'height': PROFILE_HEIGHT,
        'width': PROFILE_WIDTH,
        'cell_block': BLOCK,
        'temporal_resolution': 'hour-of-week, Europe/Moscow',
        'heading_order': ['NE', 'SE', 'SW', 'NW'],
        'speed_reference': 'cell-and-direction 90th percentile of observed weekly-hour means',
        'measured_share': float(np.count_nonzero(encoded)) / encoded.size,
        'sha256': hashlib.sha256(binary).hexdigest(),
    }
    output.with_suffix('.json').write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True,
                        help='Extracted Traffic4cast 2021 MOSCOW folder containing training/*.h5')
    parser.add_argument('--output', type=Path, required=True,
                        help='Output stem, e.g. data/traffic4cast/moscow-2019')
    parser.add_argument('--year', type=int, default=2019,
                        help='2019 pre-COVID baseline; 2020 only if deliberately selected')
    args = parser.parse_args()
    metadata = build_profile(args.source, args.output, args.year)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
