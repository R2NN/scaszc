# Локальный запуск через Docker

[Документация](README.md) · [Главный README](../README.md) · [Лицензии компонентов](../THIRD_PARTY_LICENSES.md)

## Быстрый запуск интерфейса и API

Из корня репозитория с установленными Docker Engine и Compose:

```bash
docker compose build app
docker compose up -d app
curl http://127.0.0.1:8787/api/health
```

Адрес сайта — `http://127.0.0.1:8787/`. Сборка устанавливает зависимости по `pnpm-lock.yaml` и `requirements-full.txt`, собирает React, включает сервер Node и Python-планировщик, а также устанавливает недельный архив МЦК/МЦД с проверкой контрольных сумм. Первый запрос к API создаёт SQLite-базу и загружает проверенную контрольную смену 17.08.2026. `docker compose ps` должен показывать состояние `healthy` у `app` после загрузки.

Новые точные планы дополнительно требуют Valhalla и локальных транспортных исходников. Если они не подготовлены, API и уже проверенный день работают, а новый расчёт возвращает конкретную ошибку отсутствующего источника.

## Полный расчёт с Valhalla

Создайте локальный файл настроек: `Copy-Item .env.docker.example .env.docker` в PowerShell или `cp .env.docker.example .env.docker` в Bash. Укажите три каталога:

| Переменная | Содержимое |
| --- | --- |
| `BEEGO_VALHALLA_DATA_PATH` | Исходный `.osm.pbf` региона или готовые `valhalla_tiles` и конфигурация Valhalla. Контейнер сохраняет построенные tiles здесь же. |
| `BEEGO_GTFS_PATH` | GTFS, в том числе `routes.txt`, `trips.txt`, `stop_times.txt` и календарь. |
| `BEEGO_METRO_PATH` | Локальный файл `schema.json` с линиями и пересадками метро. |

Можно указать абсолютные пути; на Windows используйте форму `A:/путь/к/каталогу`. Данные GTFS и метро монтируются только для чтения. Валхалла может строить tiles при первом старте; для крупного PBF это длительная операция и требует свободного места на диске. Ключи `GEOAPIFY_API_KEY`, `YANDEX_AI_API_KEY`, `YANDEX_AI_FOLDER_ID` и `YANDEX_RASP_API_KEY` задаются в `.env.docker` только для соответствующих внешних функций. Файл исключён из Git и сборочного контекста.

```bash
docker compose --env-file .env.docker --profile routing up -d --build
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker exec app \
  /opt/beego-venv/bin/python /app/algorithm/tools/ensure_local_valhalla.py \
  --endpoint http://valhalla:8002
```

Проверка Valhalla должна вернуть `READY` от реального сервиса. Затем запустите новый расчёт из интерфейса и убедитесь, что итог прошёл независимую проверку. Для первичного ввода транспортных источников и выбора сценарной даты см. [документацию данных](data.md). В контейнере URL маршрутизатора передаётся и интерфейсу, и Python-конвейеру через `VALHALLA_ROUTE_ENDPOINT`; пути 127.0.0.1 стенда не используются.

## Состояние и обновление

| Ресурс | Где хранится |
| --- | --- |
| SQLite | Volume `beego-db` |
| Временные расчёты | Volume `beego-runs` |
| Индексы и кэш транспорта | Volume `beego-cache` |
| Проверенные версии перепланирования | Volume `beego-replans` |
| Tiles Valhalla | Каталог `BEEGO_VALHALLA_DATA_PATH` на хосте |

`docker compose down` останавливает контейнеры, сохраняя эти данные. Для обновления выполните `docker compose --profile routing up -d --build`; без локального маршрутизатора используйте `docker compose up -d --build app`. Порт задаётся `BEEGO_HTTP_PORT` и по умолчанию доступен только с локального компьютера. Для публичного развёртывания нужен отдельный HTTPS-прокси и доступ по домену; текущий стенд описан в [руководстве VM](../deploy/README_RU.md).
