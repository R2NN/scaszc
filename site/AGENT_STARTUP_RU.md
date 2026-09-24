# Инструкция для агента: как полностью поднять BeeGo!

Эта инструкция обязательна для любого нового агента или разработчика, который получает ZIP проекта. Не заменяйте реальные алгоритмические артефакты заглушками и не возвращайте старый результат `200/205`.

## 1. Сначала прочитать

1. `AGENTS.md` — долговременные продуктовые правила.
2. `START_HERE.md` — состав комплекта.
3. `HANDOFF_INTEGRATION_GUIDE.md` — источники истины и архитектура.
4. `docs/algorithm-integration.md` — контракт сайта с планировщиком.
5. `algorithm/NEW_DATA_RUNBOOK.md` и `algorithm/routing_README.md` — пересчёт новых данных.

## 2. Быстро поднять рабочий сайт

Предпосылки: Windows 10/11, Node.js 20 LTS или новее, свободные порты `5173` и `8787`.

```powershell
Set-Location -LiteralPath '<распакованный каталог BeeGo_FULL_TRANSFER_2026-09-22>'
Set-ExecutionPolicy -Scope Process Bypass
.\START_SITE.ps1
```

Скрипт:

1. проверяет Node.js и npm;
2. выполняет `npm ci`, если `node_modules` отсутствует;
3. запускает API командой `npm run dev:api` на `127.0.0.1:8787`;
4. запускает Vite frontend на `127.0.0.1:5173`;
5. проверяет frontend, отдельный backend и встроенный Vite API;
6. открывает браузер.

Проверить вручную:

```powershell
Invoke-WebRequest http://127.0.0.1:5173/ -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:5173/api/health -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:8787/api/health -UseBasicParsing
```

Ожидается HTTP `200`, а health endpoint должен вернуть `beego-planning-adapter` и `beeline-planning-ortools-exact`.

## 3. Секреты и геокодирование

Файл `.dev.vars` намеренно отсутствует. Не искать и не публиковать старый ключ. Для новых адресов:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Затем владелец проекта самостоятельно добавляет `GEOAPIFY_API_KEY`. Без ключа работают карта, импорт уже геокодированных данных, готовые планы, аналитика и все контрольные сценарии.

## 4. Обязательные проверки перед изменениями

```powershell
pnpm run build
pnpm run test:sites
pnpm run test:algorithm
$files=(Get-ChildItem -LiteralPath tests -Filter *.test.mjs -File).FullName; node --test $files
```

Контрольные результаты:

- исходный план: `205/205`, 28 активных бригад;
- событийный план: `206/206`, 28 активных бригад;
- оба результата: `EXACT_VALID`, `publication_allowed=true`, `validation.status=VALID`;
- веб-наборы тестов: полный набор файлов `tests/*.test.mjs`.

## 5. Где лежит новый алгоритм

- Python-код: `algorithm/src/`;
- инструменты запуска: `algorithm/tools/`;
- текущие проверенные результаты: `algorithm/artifacts/current/`;
- реальные входы: `data/dataset/`;
- быстрые матрицы: `data/screening/`;
- общественный транспорт: `data/transit/`;
- кэш точной маршрутизации: `runtime/full-coverage-route-cache.sqlite3`;
- мост Valhalla: `runtime/valhalla_bridge.py`;
- тайлы, базы и PBF: `valhalla-data/`;
- браузерный экспорт планов: `public/data/beego-exact-plans.json`.

Для Python-тестов:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e .\algorithm
$env:PYTHONPATH = (Resolve-Path .\algorithm\src)
python -m pytest .\algorithm\tests -q
```

Для полного нового дня использовать `algorithm/tools/run_new_dataset_pipeline.py`. Не запускать тяжёлый пересчёт до чтения `algorithm/NEW_DATA_RUNBOOK.md`. Если Valhalla недоступен, результат должен оставаться `ROUTING_INCOMPLETE`; запрещено подменять дорожные маршруты прямыми линиями.

## 6. Правила работы агента

- Сохранять рабочие `/api/plan` и `/api/replan`; ручное `/api/reassign` удалено.
- Публиковать только независимо проверенный план.
- Не считать локальный лимит поиска доказательством глобальной невозможности.
- Не затирать историческую аналитику новым импортом: новая смена объединяется с историей по дате.
- Не удалять `public/data`, `public/test-data`, `algorithm/artifacts/current`, `data`, `runtime`, `valhalla-data` и `models`.
- После изменений снова выполнить проверки раздела 4 и визуально открыть сайт.

## 7. Повторная упаковка

```powershell
python .\scripts\build-portable-archive.py --output "$env:USERPROFILE\Desktop\BeeGo_FULL_TRANSFER_2026-09-22.zip"
```

Скрипт исключает `.git`, `node_modules`, кэши и `.dev.vars`, включает офлайн-Valhalla, исходные GTFS, железнодорожный снимок и схему метро, затем создаёт проверяемый SHA-256. При отсутствии источников в локальных путях задайте `--gtfs-dir`, `--rail-dir`, `--metro-schema` и `--valhalla-dir`. На компьютере получателя исходные транспортные файлы уже находятся внутри архива.
