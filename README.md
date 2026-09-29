# BeeGo! — планирование выездных инженеров

Прототип диспетчера по кейсу «Билайн Бизнес». Сайт импортирует заявки и инженеров, показывает их на карте, строит проверенные маршруты с учётом окон, навыков, транспорта и оборудования, а также перестраивает план после события.

## Состав

| Каталог | Назначение |
| --- | --- |
| `site/src` | интерфейс React |
| `site/worker`, `site/scripts/dev-api.mjs` | API и адаптер опубликованных планов |
| `algorithm/src`, `algorithm/tools` | точный расчёт и независимая валидация |
| `data/dataset`, `data/screening` | демонстрационный набор и матрицы |
| `algorithm/artifacts/current`, `site/public/data` | проверенные результаты для демонстрации |

Маршрут расчёта: импорт → проверка полей и координат → матрицы времени и расстояния → OR-Tools → точная маршрутизация → независимая проверка → публикация. Готовый план 205/205 и событие 206/206 имеют статус `EXACT_VALID`; результаты для новых данных публикуются только после той же проверки.

## Локальный запуск

Node.js 20+, pnpm и Python 3.12+ для нового расчёта. Из каталога `site`:

```powershell
pnpm install --frozen-lockfile
pnpm run dev:api
```

В другом терминале:

```powershell
pnpm run dev -- --host 127.0.0.1 --port 5173
```

Открыть `http://127.0.0.1:5173/`; проверка API: `http://127.0.0.1:8787/api/health`. Для геокодирования новых адресов нужен `GEOAPIFY_API_KEY` в `site/.dev.vars` по образцу `site/.dev.vars.example`. Если координаты уже указаны, геокодер не нужен.

Для пересчёта новых наборов нужны локальная Valhalla и дополнительные данные маршрутизации из исходного полного ZIP. Сам Git-репозиторий содержит код и демонстрационные результаты; большие офлайн-тайлы, транспортные исходники и секреты хранятся отдельно. Подробности — [развёртывание](deploy/README_RU.md).

## Проверки

```powershell
cd site
pnpm run build
pnpm run test:sites
pnpm run test:algorithm
pnpm run test:analytics-history
pnpm exec node --test tests/planning-slot.test.mjs
cd ..
$env:PYTHONPATH='algorithm/src;algorithm'
python -m unittest discover -s algorithm/tests -p 'test_*.py' -q
```

Сверка с ТЗ и известные ограничения — [отчёт о готовности](DELIVERY_AUDIT_RU.md). Для защиты подготовлены [презентация](presentation/BeeGo-defense.pptx) и [порядок показа](presentation/DEMO_SCRIPT_RU.md). Технические детали алгоритма — [маршрутизация](algorithm/routing_README.md) и [новый набор данных](algorithm/NEW_DATA_RUNBOOK.md).
