from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / 'valhalla-runtime.json'
CLI_SOURCE = ROOT / 'valhalla_route_cli.cpp'
CONFIG = Path('/tmp/valhalla-generated.json')
CLI = Path('/tmp/valhalla_route_cli')


def _run(*command: str, capture_output: bool = False) -> subprocess.CompletedProcess[str]:
    """Run a required local Valhalla tool and surface its real failure."""
    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=capture_output,
    )


def _load_object(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise RuntimeError(f'Valhalla config must be an object: {path}')
    return payload


def _prepare_config() -> None:
    """Generate a current-schema config while retaining the mounted tile paths."""
    template = _load_object(TEMPLATE)
    generated = _run('valhalla_build_config', capture_output=True)
    config = json.loads(generated.stdout)
    if not isinstance(config, dict):
        raise RuntimeError('valhalla_build_config returned a non-object config')
    template_mjolnir = template.get('mjolnir')
    config_mjolnir = config.get('mjolnir')
    if not isinstance(template_mjolnir, dict) or not isinstance(config_mjolnir, dict):
        raise RuntimeError('Valhalla config has no mjolnir section')
    path_keys = (
        'tile_dir', 'tile_extract', 'traffic_extract', 'admin', 'landmarks',
        'timezone', 'transit_dir', 'transit_feeds_dir', 'default_speeds_config',
    )
    for key in path_keys:
        if key in template_mjolnir:
            config_mjolnir[key] = template_mjolnir[key]
    template_extra = template.get('additional_data')
    if isinstance(template_extra, dict):
        config.setdefault('additional_data', {}).update(template_extra)
    tile_extract = config_mjolnir.get('tile_extract')
    if not isinstance(tile_extract, str) or not Path(tile_extract).is_file():
        raise RuntimeError(f'Valhalla tile extract is unavailable: {tile_extract!r}')
    temporary = CONFIG.with_suffix('.new.json')
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(CONFIG)


def _build_cli() -> None:
    """Compile the bridge CLI against the installed Valhalla headers and ABI."""
    if not CLI_SOURCE.is_file():
        raise RuntimeError(f'Valhalla bridge source is missing: {CLI_SOURCE}')
    temporary = CLI.with_name(f'{CLI.name}.new')
    _run(
        'g++', '-O2', '-std=c++23', str(CLI_SOURCE), '-o', str(temporary),
        '-lvalhalla',
    )
    temporary.replace(CLI)


def main() -> int:
    try:
        _prepare_config()
        _build_cli()
    except (OSError, RuntimeError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(json.dumps({'status': 'UNAVAILABLE', 'error': str(error)}), file=sys.stderr)
        return 2
    print(json.dumps({
        'status': 'READY',
        'config': str(CONFIG),
        'cli': str(CLI),
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
