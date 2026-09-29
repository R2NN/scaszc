# Лицензии компонентов и источников BeeGo!

[Главный README](README.md) · [Документация Docker](docs/docker.md)

Ниже перечислены прямые программные зависимости и источники данных, которые используются в текущей системе. Версии JavaScript сверены с `site/pnpm-lock.yaml` и локальными `package.json`, версии Python — с `algorithm/requirements-full.txt` и метаданными установленных пакетов. Транзитивные зависимости и их тексты лицензий находятся в устанавливаемых пакетах; перед распространением собранного образа их перечень следует получать из конкретной сборки.

| Компонент | Назначение | Лицензия или условия |
| --- | --- | --- |
| React 19.2.0, React DOM 19.2.0 | Интерфейс | MIT |
| Vite 6.4.2, `@vitejs/plugin-react` 5.0.4 | Сборка интерфейса | MIT |
| MapLibre GL JS 6.10.0 | Интерактивная карта | BSD-3-Clause |
| Lucide React 1.47.0 | Иконки | ISC |
| better-sqlite3 13.0.3 | Локальная операционная база | MIT |
| PDFKit 0.20.2 | PDF-отчёт | MIT |
| pdfjs-dist 5.7.284 | Просмотр PDF | Apache-2.0 |
| SheetJS `xlsx` 0.18.5 | Импорт таблиц | Apache-2.0 |
| [Valhalla](https://github.com/valhalla/valhalla/blob/master/COPYING) | Локальная дорожная маршрутизация | MIT |
| [OR-Tools](https://github.com/google/or-tools/blob/stable/LICENSE) 9.15.6755 | CP-SAT и маршрутизация | Apache-2.0 |
| [aiohttp](https://github.com/aio-libs/aiohttp/blob/master/LICENSE.txt) 3.11.10 | Асинхронные запросы Python | Apache-2.0 |
| [pandas](https://github.com/pandas-dev/pandas/blob/main/LICENSE) 2.2.3 | Подготовка данных | BSD-3-Clause |
| pytest 8.3.4 | Тесты | MIT |

## Картографические и транспортные данные

| Источник | Использование | Условия |
| --- | --- | --- |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | Дорожный граф Valhalla и основа карты | ODbL 1.0; атрибуция © OpenStreetMap contributors. |
| [OpenFreeMap](https://openfreemap.org/) | Публичные векторные тайлы и стиль карты | Условия сервиса и атрибуция поставщиков карты; стиль выводится через MapLibre. |
| [Geoapify](https://www.geoapify.com/terms-and-conditions/) | Подсказки адресов и геокодирование при наличии ключа | Условия API; для бесплатного тарифа требуется атрибуция Geoapify и OpenStreetMap. |
| [Яндекс Расписания](https://yandex.ru/legal/rasp_api/ru) | Сохранённые недельные снимки МЦК/МЦД | Условия API и источника данных; это не открытая программная лицензия. |
| GTFS и схема метро | Локальный транспортный индекс | Права определяются источником конкретного загруженного набора; эти каталоги не входят в Docker-образ. |

Этот перечень не назначает лицензию собственному коду и не переоформляет права на внешние наборы данных. При публикации или повторном использовании данных применяются условия их источников.
