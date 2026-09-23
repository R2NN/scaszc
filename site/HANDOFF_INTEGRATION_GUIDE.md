# BeeGo! — инструкция по переносу в основной проект

> Примечание для полного архива от 22.09.2026: этот документ был подготовлен на этапе, когда веб-проект обозначался как `site/`. В текущем ZIP содержимое `site/` уже находится прямо в корне распакованного каталога. Например, `site/src/` означает `src/`, а `site/public/` означает `public/`. Для запуска сначала используйте `AGENT_STARTUP_RU.md` и `START_SITE.ps1`.

Этот пакет фиксирует рабочее состояние BeeGo! на 21 сентября 2026 года. Он предназначен для передачи другому разработчику или агенту, который должен встроить текущую аналитику, объяснения, данные, CatBoost и алгоритм планирования в основной проект без замены реальной логики заглушками.

## 1. Что считать источником истины

1. Актуальный интерфейс и вся вкладка «Аналитика» — `site/src/` вместе с `site/public/`, `site/worker/`, `site/package.json` и lock-файлами.
2. Проверенные планы — `algorithm/artifacts/current/` и их браузерный экспорт `site/public/data/beego-exact-plans.json`.
3. Основной вход алгоритма — `data/dataset/`.
4. Готовые поисковые матрицы — `data/screening/`.
5. Индекс общественного транспорта — `data/transit/moscow_2026-08-17.sqlite`.
6. Уже выполненные точные запросы маршрутизации — `runtime/full-coverage-route-cache.sqlite3`.
7. Полный офлайн-runtime Valhalla — `valhalla-data/` в корне ZIP.
8. Полугодовая аналитика — `site/public/data/analytics-history.json`: 180 смен, 19.02.2026–17.08.2026.
9. Обученная ML-модель — `site/models/demand-forecast-catboost.cbm`.

Не возвращать старые частичные результаты. Актуальная исходная смена закрывает 205 из 205 заявок на 28 бригадах; событийный сценарий — 206 из 206 на тех же 28 бригадах. Ограниченный поиск нельзя описывать как доказательство невозможности назначения.

## 2. Состав пакета

### Интерфейс и аналитика

- `site/src/AnalyticsWorkspace.jsx` — единая вкладка аналитики: итог смены, ресурсы, история и «Центр решений».
- `site/src/AnalyticsAdvancedPanels.jsx` — сравнения, аномалии, прогноз спроса, экономика и календарь в стиле BeeGo!.
- `site/src/analyticsHistory.js` — расчёт истории, план-факта и агрегатов.
- `site/src/analyticsAdvanced.js` — расширенные показатели, прогнозные разрезы, цели, экономика и рекомендации.
- `algorithm/src/beeline_planning/baseline.py` и `algorithm/tools/build_exact_fcfs_baseline.py` — FCFS-бейзлайн на том же Valhalla/транспортном стеке и с тем же независимым валидатором.
- `site/src/baselinePlanning.js` — только проверяет и показывает опубликованный `EXACT_VALID`-бейзлайн; браузерного приближения нет.
- `site/scripts/exact-replan-runner.mjs`, `site/algorithm/tools/replan_ui_event.py` и `site/src/replanningInput.js` — точное динамическое перепланирование и импорт аварийных заявок.
- `site/src/analytics.css` и `site/src/analytics-advanced.css` — вся верстка аналитики.
- `site/src/BusinessSelect.jsx` и `site/src/business-select.css` — фирменные селекты вместо нативных раскрывающихся списков.
- `site/src/App.jsx` — навигация, входные свойства аналитики и связь с боевым планом/картой.
- `site/public/data/` — история, планы, ML-прогноз и геоданные.
- `site/public/test-data/` — полные входные данные для интеграционных проверок.
- `site/tests/` — проверки сайта, аналитики, ML и связи с алгоритмом.
- `site/dist/` — готовая production-сборка текущего состояния.

Самый безопасный способ переноса — переносить `site/src`, `site/public`, `site/worker`, `site/scripts`, `site/tests` и конфигурацию сборки целиком. Если основной проект уже сильно разошёлся, переносить перечисленные файлы как один связанный модуль, а не только JSX: вычисления, стили, данные и callbacks взаимозависимы.

### Полугодовые данные и ML

- `site/public/data/analytics-history.json` — 180 последовательных смен.
- `site/scripts/generate-analytics-history.mjs` — воспроизводимый генератор истории.
- `site/public/data/ml-demand-training.csv` — 50 544 подготовленных наблюдения для CatBoost.
- `site/models/demand-forecast-catboost.cbm` — обученный `CatBoostRegressor`.
- `site/public/data/ml-demand-forecast.json` — опубликованный прогноз и метрики обучения.
- `site/scripts/train-demand-forecast.py` — генерация выборки, обучение, сохранение модели и экспорт прогноза.
- `site/requirements-ml.txt` — зафиксированные версии Python-зависимостей ML.

Модель не нужна браузеру во время показа уже рассчитанного прогноза, но нужна для переобучения и серверного инференса. Пример загрузки:

```python
from catboost import CatBoostRegressor

model = CatBoostRegressor()
model.load_model('site/models/demand-forecast-catboost.cbm')
```

Не менять порядок признаков. Он зафиксирован в `site/scripts/train-demand-forecast.py` (`FEATURES`) и продублирован в `ml-demand-forecast.json` (`training.features`).

### Алгоритм и объяснения

- `algorithm/src/beeline_planning/` — ограничения, поиск, проверка и публикация планов.
- `algorithm/src/beeline_routing/` — провайдеры и нормализация мультимодальных маршрутов.
- `algorithm/tools/` — подготовка данных, построение матриц, полный прогон, ремонт, объяснения и упаковка.
- `algorithm/tests/` — тесты алгоритма и маршрутизации.
- `algorithm/artifacts/current/` — актуальные проверенные планы, полные маршруты и детерминированные объяснения.
- `algorithm/artifacts/research/` и `algorithm/work/` — материалы поиска и воспроизводимости; не публиковать их вместо `current`.
- `algorithm/routing_README.md` — подробная техническая документация маршрутизации.
- `algorithm/NEW_DATA_RUNBOOK.md` — запуск на новом наборе.
- `algorithm/BENCHMARK_2026-09-18.md` — контрольные результаты и производительность.
- `source_materials/` — исходное ТЗ, нормативы, первоначальные данные и архив экспериментов.

Объяснения назначения не являются подготовленным текстом: они выводятся из фактически проверенных ограничений, кандидатов и маршрутов артефакта `exact-205-of-205-28-teams-clean-automatic.json`. При переносе нельзя заменять их статическими UI-строками.

### Valhalla и рассчитанные маршруты

- `valhalla-data/valhalla_tiles.tar` — готовые дорожные тайлы Центрального федерального округа.
- `valhalla-data/central-fed-district-260915.osm.pbf` — источник для пересборки тайлов.
- `valhalla-data/admins.sqlite`, `timezones.sqlite`, `default_speeds.json`, `valhalla.json` — runtime-данные и конфигурация.
- `runtime/valhalla_bridge.py`, `prepare_valhalla_runtime.py`, `valhalla_route_cli.cpp` — локальный мост и подготовка ABI-совместимого CLI.
- `runtime/full-coverage-route-cache.sqlite3` — 4 554 сохранённых ответа точной маршрутизации.
- `data/screening/*.csv` — 12 готовых матриц для автомобиля, велосипеда, пешего и общественного транспорта по трём территориям.
- `algorithm/artifacts/current/*.json` — уже рассчитанные последовательности визитов, геометрии, времена, расстояния и provenance маршрутов.

В ZIP входят все данные Valhalla, но не входит системный бинарник Valhalla: он зависит от ОС и ABI. Для нового расчёта установите Valhalla 3.8.3 в WSL/Linux или используйте совместимый контейнер, смонтировав `valhalla-data` как `/custom_files`. Для просмотра сайта и использования уже рассчитанных планов сервер Valhalla не нужен.

## 3. Порядок интеграции в основной проект

1. Проверить SHA-256 внешнего ZIP по соседнему файлу `.sha256`, затем сверить внутренний `SHA256SUMS.txt`.
2. Скопировать без переименований `algorithm/`, `data/`, `runtime/`, `valhalla-data/` и `source_materials/`.
3. Перенести статические данные `site/public/data/` и `site/public/test-data/` до подключения компонентов.
4. Перенести вычислительные модули аналитики, затем панели и CSS, затем подключение из `App.jsx`.
5. Сохранить контракт `AnalyticsWorkspace`: `orders`, `team`, `plan`, `date`, `onDateChange`, `dateControl`, `onOpenUnassigned`, `onOpenRoutes`, `onPreviewReplan`, `onApplyReplan`, `onRollbackReplan`, `onStartLiveReplan`.
6. Убедиться, что `fetch` статических файлов учитывает `import.meta.env.BASE_URL`, как в текущей реализации.
7. Не смешивать регионы: выбранный кластер фильтрует заявки, инженеров, маршруты и рекомендации совместно.
8. После слияния выполнить все проверки из следующего раздела и визуально пройти четыре представления аналитики.

Если в основном проекте другие сущности, лучше написать адаптер входных данных к текущему контракту, чем переписывать расчёты аналитики. Идентификаторы заявок и инженеров должны совпадать между `orders`, `team`, `plan.routes` и `plan.unassigned`.

## 4. Запуск и проверка

### Сайт

```powershell
cd site
npm install
npm run test:algorithm
npm run test:analytics-history
npm run test:sites
npm run build
```

`pnpm` также поддерживается, но в окружениях с запретом install-скриптов необходимо заранее разрешить сборку `esbuild`. Новые production-зависимости не требуются.

### CatBoost

```powershell
python -m venv .venv-ml
.\.venv-ml\Scripts\Activate.ps1
python -m pip install -r site\requirements-ml.txt
cd site
python scripts\train-demand-forecast.py
npm run test:ml-forecast
```

### Python-ядро

```powershell
python -m venv .venv-algorithm
.\.venv-algorithm\Scripts\Activate.ps1
python -m pip install -e .\algorithm
$env:PYTHONPATH = (Resolve-Path .\algorithm\src)
python -m pytest .\algorithm\tests -q
```

### Новый набор данных

Не запускать отдельные инструменты в случайном порядке. Использовать `algorithm/tools/run_new_dataset_pipeline.py` и инструкции `algorithm/NEW_DATA_RUNBOOK.md`. Публиковать новый план только если финальная независимая проверка возвращает `validation.status = VALID` и `publication_allowed = true`.

## 5. Приёмочный чек-лист после переноса

- В меню одна вкладка «Ресурсы», отдельной вкладки «Резервы» нет.
- «Ресурсы» поддерживают поиск, навык, транспорт, регион, состояние и оба режима списка.
- Оптимизация смен открывается в боковой шторке и поддерживает применение/откат.
- «Центр решений» содержит четыре сценария, расчёт «Было → Стало», объяснение и принятие/откат черновика.
- Сценарий называется «Инженер недоступен»; отдельного громоздкого блока «Риски / Запас времени» нет.
- В «Истории» нет подвкладки моделирования; прогноз спроса использует фирменный календарь.
- История покрывает 180 дней, а не старые 35.
- CatBoost-модель физически присутствует и загружается.
- Основной план остаётся 205/205, событийный — 206/206; оба используют 28 активных бригад.
- Кэш Valhalla, транспортный индекс, матрицы и офлайн-тайлы доступны.
- Ни для неизвестных маршрутов, ни для объяснений не используются заглушки.

## 6. Контроль целостности

В корне архива находятся:

- `FILE_INVENTORY.json` — машинный перечень файлов и размеров;
- `SHA256SUMS.txt` — SHA-256 каждого переданного файла;
- рядом с ZIP — `<имя>.zip.sha256` для проверки самого архива.

Если хотя бы одна контрольная сумма не совпала, интеграцию следует остановить и повторно передать архив.
