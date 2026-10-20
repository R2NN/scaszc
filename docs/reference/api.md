# API: основные сценарии и контракты

[Документация](../README.md) · [Архитектура](architecture.md) · [Операционная смена](shift-operations.md)

API обслуживается тем же Node-процессом, что отдаёт интерфейс. JSON-запросы используют `Content-Type: application/json`. Ниже приведены рабочие маршруты основных сценариев; точные поля и проверки задают связанные обработчики и тесты.

## Готовность

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/health` | Доступность API. |
| `GET /api/runtime/readiness` | Python, Valhalla и канонический транспортный индекс; готовый комплект возвращает `ready: true`. |
| `GET /api/base-data/status` | Доступность исходных операционных данных. |

## Первичный расчёт

[exactPlanningApi.mjs](../../site/server/exactPlanningApi.mjs) принимает `POST /api/plan/jobs` с заявками, составом и датой. Ответ содержит ID задачи; `GET /api/plan/jobs/:id` возвращает прогресс и результат. `POST /api/plan` поддерживает непосредственный ответ. Снимки длительности подготавливаются сервером. Проверенный результат связывается с входами и сохраняется через `POST /api/shifts`.

## Смена и публикация

Обработчик: [operationsApi.mjs](../../site/server/operationsApi.mjs).

| Метод и путь | Результат |
| --- | --- |
| `GET /api/shifts?regionId=moscow&date=2026-08-17` | Сохранённый день с заявками, составом, планом и ревизией. |
| `POST /api/shifts` | Сохранение начального проверенного плана; сервер сверяет квитанцию расчёта. |
| `GET /api/shifts/:id` | Текущее состояние дня. |
| `POST /api/shifts/:id/preview` | `{ expectedRevision, event }` → `202`, ID задачи и `RUNNING`. |
| `GET /api/previews/:id` | Статус, прогресс и готовый результат либо ошибка. |
| `GET /api/shifts/:id/preview` | Сохранённый черновик дня. |
| `DELETE /api/shifts/:id/preview` | Отмена указанного черновика с проверкой ревизии. |
| `POST /api/shifts/:id/publish` | `{ previewId, expectedRevision, actor }` → новый опубликованный день. |
| `POST /api/shifts/:id/facts` | Начало, завершение или невыполнение визита и измерения этапов. |
| `POST /api/shifts/:id/rollback` | `{ targetPlanId, expectedRevision, actor, time }` → новая ревизия выбранного плана. |
| `POST /api/shifts/:id/report` | Создание PDF; ответ содержит ID артефакта и URL. |
| `GET /api/shifts/:id/report?artifactId=...` | Сохранённый PDF. |
| `GET /api/shifts/:id/report-data` | Структурированные данные отчёта. |
| `GET /api/shifts/:id/ai/status` | Настройка AI и доступный бюджет. |
| `POST /api/shifts/:id/ai/question` | Вопрос по снимку выбранной смены. |

Событие содержит `type`, минутное `time` в формате `HH:MM`, `reason` и данные затронутой заявки/бригады. Типы определены в [shiftDomain.js](../../site/src/shiftDomain.js): пересчёт, новая/отменённая заявка, отмена визита, доступность и замена инженера, добавление ресурса, ручное назначение, границы смены, окно клиента, длительность и старт.

Готовность черновика и публикация — два действия. Хранилище сверяет базовую ревизию, защищённые визиты, `EXACT_VALID`, `publicationAllowed`, независимый `VALID` и SHA. Общий занятый расчётный слот возвращает HTTP 429; клиент показывает причину и возможность повторить действие.

## Длительность и паспорт

Обработчик: [complexityApi.mjs](../../site/server/complexityApi.mjs).

| Метод и путь | Назначение |
| --- | --- |
| `GET/POST /api/complexity/model` | Чтение модели и сохранение версии норм/весов с датой действия. |
| `POST /api/complexity/validate-orders` | Серверная проверка вводимых заявок. |
| `POST /api/complexity/estimate` | Расчёт снимка по заявке; `persist: false` используется для предпросмотра. |
| `GET /api/complexity/objects` | Объекты и оценка времени с фильтрами вида работ, даты и территории. |
| `GET /api/complexity/objects/:id` | Паспорт, пример заявки, расчёт, визиты, особенности и обратная связь. |
| `GET /api/complexity/accuracy` | Ошибки прогноза на сопоставимых измерениях. |
| `POST /api/complexity/visits/:id/feedback` | Ответ инженера по визиту. |
| `GET /api/complexity/visits/:id/feedback/impact` | Проверка переноса причины на выбранную область. |
| `POST /api/complexity/visits/:id/feedback/decision` | Решение по обратной связи. |
| `POST /api/complexity/decisions` | Решение по наблюдениям и условию обслуживания. |
| `PATCH /api/complexity/visits/:id` | Уточнение либо исключение измерения с основанием. |
| `PATCH /api/complexity/conditions/:id` | Закрытие действующей особенности с причиной. |

`at` задаёт момент оценки; `kind` — вид работ, `volume` — стандартный объём либо объём заявки. Текущий разбор истории использует `review=current`, сохраняя исходный снимок опубликованного визита.

<a id="rating"></a>
## Рейтинг и состав

Обработчик: [ratingApi.mjs](../../site/server/ratingApi.mjs).

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/ratings/engineers` | Каталог с оценками и версией рейтинга. |
| `GET /api/ratings/engineers/:id` | Подробности специалиста и отзывы. |
| `POST /api/ratings/reviews` | Уникальный отзыв завершённому визиту. |
| `GET/POST /api/ratings/cases` | Список разборов / создание обращения. |
| `GET /api/ratings/cases/:id` | Переписка, исходный отзыв и решения. |
| `POST /api/ratings/cases/:id/messages` | Сообщение в разборе. |
| `POST /api/ratings/cases/:id/decision` | Решение с `expectedRevision`, основанием и ответом. |
| `POST /api/ratings/cases/:id/reopen` | Повторное открытие. |
| `PATCH /api/ratings/cases/:id/triage` | Просмотр и отметка обращения. |
| `GET /api/ratings/staffing` | Данные подбора и прогноз для региона, даты и диапазона. |
| `POST /api/ratings/scenarios` | При `kind: staffing` создаёт предложение `AWAITING_CONFIRMATION`. |
| `POST /api/ratings/scenarios/:id/confirm` | Сверяет источник, состав и рейтинг, фиксирует людей и запускает расчёт. |
| `GET /api/ratings/scenarios/:id` | Прогресс и результат. |
| `POST /api/ratings/scenarios/:id/save` | Сохранение готового полного реального состава. |
| `POST /api/ratings/scenarios/:id/reassign` | Проверяемое ручное переназначение в рейтинговом сценарии. |

Подбор получает `regionId`, `date`, `pool: staff | all`, `kind: staffing` и `settings: { qualityFloor, qualityCeiling }`. Пример диапазона — `3.6–4.9`. Подтверждение допустимо только для актуального предложения; [детальный контракт](rating-workflow-and-planning.md) описывает отпечатки и поиск.

## Аварии и транспорт

Обработчики: [dispatchApi.mjs](../../site/server/dispatchApi.mjs), [transportApi.mjs](../../site/server/transportApi.mjs).

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/dispatch/context?baseShiftId=...` | Текущая оперативная сессия исходного дня. |
| `POST /api/dispatch/sessions` | Новый прогон. |
| `POST /api/dispatch/sessions/entry` | Вход в подходящий учебный сценарий. |
| `POST /api/dispatch/shifts/:id/clock` | Изменение версионированных серверных часов. |
| `GET/POST /api/dispatch/shifts/:id/policy` | Политика автоматического выбора. |
| `GET/POST /api/dispatch/shifts/:id/incidents` | Чтение инцидентов / создание аварии. |
| `POST /api/dispatch/incidents/:id/accept` | Подтверждение `candidateId` выбранного инженера. |
| `POST /api/dispatch/incidents/:id/retry` | Повтор поиска. |
| `POST /api/dispatch/incidents/:id/cancel` | Отмена инцидента. |
| `GET /api/transport/catalog` | Станции, связи и каталог транспорта. |
| `POST /api/transport/draw` | Привязка линии `{ points, mode }` к дорожной сети. |
| `GET/POST /api/transport/events` | Чтение / сохранение ограничения выбранной смены. |
| `POST /api/transport/previews` | Расчёт последствий по текущей ревизии и времени. |
| `GET /api/transport/previews/:id` | Прогресс и проверенный вариант обхода. |
| `POST /api/transport/previews/:id/apply` | Применение проверенного решения. |
| `POST /api/transport/previews/:id/cancel` | Отмена проверки. |

Дорожные точки API передаются как `[latitude, longitude]`, MapLibre получает `[longitude, latitude]`. Сетевой путь проверяется с учётом направления, интервала закрытия, режима транспорта, входов и пересадок. При принятии аварии маршрут уточняется от текущего состояния именно выбранного специалиста.

## Общая неисправность

[serviceContextApi.mjs](../../site/server/serviceContextApi.mjs) обслуживает `GET`, `PUT`, `PATCH`, `POST /api/service-context?shiftId=...`. Запись требует `revision`, относящуюся к этой смене. `PUT` импортирует согласованный набор; `PATCH` меняет статус, детали восстановления, заметку, решение по заявке или подготовку переноса. Для конкурирующего сохранения возвращается 409. Размер входа ограничен 2 МБ. Статус узла и решение по выезду фиксируются в контексте; изменение расписания проходит обычный черновик и публикацию.

## Контроль изменений

Изменяющие запросы выполняйте на отдельной QA-базе. Минимальный сценарий интеграции: получить ревизию → запустить черновик → дождаться готовности → проверить результат → явно подтвердить → перечитать опубликованную смену. Эталоны запросов и проверка ошибок находятся в `site/tests/ratings.test.mjs`, `staffing.test.mjs`, `shift-operations.test.mjs`, `transport.test.mjs`, `service-context.test.mjs`.
