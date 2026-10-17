# Rating — design and interaction QA

Date: 2026-10-17 (Europe/Moscow).

## Source visual truth

Approved images, under `C:/Users/bio24/.codex/generated_images/01a14620-d9d9-7982-95c1-d546bf18e606/`:

- Compact: `exec-9e614a39-f3b7-4d79-8aa4-2e42e738b664.png`.
- Messenger: `exec-d52ad839-a1e6-4130-96f2-a9cf3f0599a7.png`.
- Full rating: `exec-6b2f0605-1a9a-42d2-8566-38a683b043a2.png`.

The latest written corrections take precedence: «Рейтинг», information behind ⓘ, no review calendar, larger profile at the bottom right, full-screen toggle, and the existing Orders interface for the plan.

## Rendered evidence and normalization

Local implementation: http://127.0.0.1:8787/.

All evidence below is in `C:/Users/bio24/OneDrive/Desktop/ЛЦТ/outputs/bego-local-qa/`.

- `rating-compact.jpg`, `rating-full.jpg`, `rating-cases.jpg`: 1672 × 941 pixels, same as the generated source images. Requested desktop viewport 1672 × 941; the app retains its existing 90% UI zoom (browser inner-height rounding can report 942). Screenshot density is 1×. No screenshot was stretched to manufacture a match.
- `rating-laptop.jpg`, `rating-plan.jpg`: 1366 × 768.
- `rating-menu-600.jpg`: 1280 × 600, expanded navigation.
- `rating-decision.jpg`, `rating-photo.jpg`, `rating-dark.jpg`: additional functional states.
- `rating-compact-comparison.png`, `rating-full-comparison.png`, `rating-chat-comparison.png`: source and implementation together in each comparison input, with labels. Full comparison boards are 3344 × 973.
- `rating-card-detail-comparison.png`, `rating-chat-detail-comparison.png`: focused comparisons at readable size. The profile is intentionally taller than the source, as requested.

State: light theme, 17.08.2026 shift, selected engineer and actual seeded quality history. Engineer names, locations, ratings, dates, case counts and messages differ from the illustrative mock because they are read from the database. The operational map uses the selected engineer's actual start and verified route. A transient capture taken during viewport resizing was discarded and recaptured after checking the card's DOM rectangle.

## Comparison history and fixes

1. Initial messenger comparison (`rating-chat-comparison-before.png`): P2 — inbox was too narrow relative to the approved composition, and conversation hierarchy was too small. Fixed the desktop inbox to 525 CSS px, with smaller breakpoint widths; increased heading/message typography; added participant avatars and incoming/outgoing bubble treatments. Final combined and focused chat captures show the intended two-column messenger structure, visible pinned review and fixed composer.
2. Compact/profile checks: increased the profile to 430 CSS px, improved score/name/review typography, retained bottom alignment, and placed it to the left of the map toolbar. Final card rectangle at the desktop target: x≈1206, width=387 rendered pixels, bottom≈936. Both the profile and navigation align at the bottom; map controls remain visible.
3. Full rating: replaced the stretched compact list with columns for number, engineer, rating, review count, skills and roster. Added the calculated score distribution to the expanded profile. Responsive breakpoints hide secondary columns before overflowing.
4. Small-height navigation: the original flex behavior squeezed links. Applied `flex-shrink:0` and a 44 px minimum link height. At 1280 × 600, navigation client-height=380 CSS px, scroll-height=577 CSS px; it scrolls. The footer remains visible and does not overlap navigation.
5. Photo viewing: attachments open inside an accessible dialog, including newly uploaded base64 images. This avoids relying on browser navigation to data URLs. Verified opening and closing the uploaded image.

## Required fidelity surfaces

- **Typography:** existing Inter / Segoe UI Variable / Segoe UI / Arial stack preserved. Headings, rating values, rows and message text have distinct hierarchy. Long names and inbox previews truncate within their columns; full text remains available in the profile or pinned review. The app's existing UI zoom is preserved instead of changing other screens to match a generated image.
- **Spacing/layout:** compact list remains the width of the existing operational panel; the profile sits at the bottom right. Expanded rating and messenger cover the map. Full view and focused comparisons show no clipped persistent controls. The plan reuses the existing territory selector, search, filters, route cards and order rows.
- **Color/tokens:** BeeGo yellow selection, pale yellow outgoing messages, neutral incoming messages and the existing purple route styling are retained. Dark theme uses the app's dark surface tokens; the profile background was verified as rgb(32,35,41), then the theme was restored.
- **Image quality:** real generated router photograph, correctly cropped in the message and fully visible in the photo dialog. Existing BeeGo brand assets and Lucide icons are reused. No mockup is used as a flattened application screen.
- **Copy/content:** no «Лидерборд», permanent «Почему такой рейтинг» block or review calendar. Synthetic history is identified. The start is labeled «Старт дня», not live GPS. Excluded scores retain their original stars and explain their treatment. Counts reflect persisted records rather than the mock's illustrative values.

Intentional differences: the existing application's panel/sidebar dimensions and 90% UI density are retained; real database contents replace illustrative values; full-screen profile contains fewer explanatory blocks because the user requested minimalism. These are accepted product constraints, not pending visual defects.

## Interactions and data checks

- Search, sorting, staff/reserve selection, shared filters, empty results and filter reset.
- Compact/full toggle; engineer selection focuses the map; old order popups clear when selecting an engineer.
- New review after a completed visit, with server-owned attribution. A supplied engineer ID cannot redirect the review to another person. Duplicate feedback is rejected.
- New appeal from a review, dispatcher messages, engineer teaching-mode input and saved decision. Tested both confirmation and exclusion; the original one-star review remains one star after exclusion.
- Photo rejection above 2 MB, successful JPEG upload, message persistence and full image dialog.
- Separate rating plan, 205/205 assigned, 1035 candidates, 32 active routes. Save survives page reload. Main shift remains revision 1, 205 orders, zero execution facts, and its original content hash.
- Actual manual move EAST-24980 from RATING-0109 to EAST-ENG-07: independently VALID, all 205 assigned, 32 used crews. Afterwards a fresh normal rating scenario was calculated and saved.
- Browser error logs checked: no application errors during the tested flows.
- Build passes. All four new rating tests pass, including the real Python optimizer. Full Node suite: 166/167 pass; the sole failure is the previously existing base-transfer archive expectation (182 operational days expected, one bundled). See `rating-node-tests.txt`, `rating-acceptance.json`, `rating-manual-proof.json`.

## Final findings

No outstanding P0/P1/P2 visual or interaction findings in the tested flows. Optional P3 polish: richer avatar styling and more metadata presentation can be explored later without changing the current workflow.

final result: passed

## Follow-up QA — rating refinements (17.10.2026)

- Compared the compact Rating panel against the Engineers panel at the local 127.0.0.1 preview: heading, rounded tabs, search field and filter rhythm now use the same sizing and BeeGo yellow selection treatment.
- Verified the rating list has no reserve/staff filter row, the plan view has no nested «Заявки» heading or composition summary, and the map-level «Пересчитать план» action remains available.
- Verified custom BeeGo dropdowns in the sort control, message role control, and decision form; no browser-blue native dropdown is rendered in the tested flows.
- Verified closing Rating returns to a neutral map with no active sidebar workspace. Browser console error log was empty.
- Added a small curated local portrait set for selected engineers and retained initials for the rest so the roster stays readable.
- Follow-up image/UI pass: replaced the earlier stock-like portraits with nine distinct generated engineer portraits, mapped without reuse; reserve engineers without an assigned portrait use initials. The fullscreen layout now expands to the available map workspace with a flexible roster column and fixed-width detail card. «Все» is the yellow review action, «Читать отзыв» is neutral gray, and the extra footer action was removed. Chat engineer avatars now use the same unique portrait mapping and attached photos preserve their aspect ratio.

## Rating card and attachment layout follow-up — 17.10.2026

- Widened the shared compact Rating/Plan panel to 460 CSS px and kept its tab rail fixed at 426 px. Corrected the indicator's content-box border overflow and button minimum height. Browser checks confirmed every tab fits; 267 animation frames retained exactly the same rail width across fullscreen toggles and a direct fullscreen-to-plan switch.
- The fullscreen engineer card now sits inside an animated width slot. Closing expands the roster/search smoothly over 460 ms; sampled widths were monotonic with 37 intermediate values. Switching engineers keeps the slot width; reselecting an engineer closes it.
- Fixed chat flex items shrinking below their content height. Photo previews reserve a 4:3 frame with contain-fit imagery, captions wrap inside bubbles, and text remains selectable. Tested existing photo messages, three-photo sending, long text, composer clearing and zero horizontal overflow at 900/1280/1600/3180 px. Send responses were intercepted in an isolated Playwright browser; these checks added no test messages to the real conversation.
- Photo viewing uses a foreground portal with no backdrop blur, a larger download button and working Escape/focus restoration. Download completed with the expected filename. Rejected invalid/oversized attachments, dismissed errors manually and verified eight-second expiry.
- Rendered both light and dark chat states; inspected chat and photo-viewer screenshots. Browser plugin unavailable; used the established Playwright CLI fallback. The only console error observed was the existing external OpenFreeMap glyph-range 404; no application runtime errors were observed in these flows.
- Validation: production build passed; ratings/map tests 7/7; Sites tests 16/16. Known build warning remains the existing large bundle advisory. This pass covers the rating/card/chat interactions above, not a fresh whole-site audit.

## Profile avatar in review-case chat — 17.10.2026

- Dispatcher message avatars now consume the live profile avatar and background tone. Checked default bee, switching to panda/mint and robot/sky through the real profile editor, immediate updates of existing messages, a new message with an intercepted POST response, and persistence after reload. Engineer portraits stayed unchanged.
- Verified the chat and sidebar image URLs and background colors match, inspected the final rendered screenshot, and confirmed contain-fit mascot geometry. Production build passed; no app runtime errors were observed. Browser plugin not available; used the established isolated Playwright CLI fallback and closed that browser afterwards.

## Messenger presentation — 17.10.2026

- Used the user's Telegram screenshots as the layout reference: compact bubbles, a date divider, inline lower-right timestamps, author names only at the start of consecutive same-author groups and avatars only at their end. Kept BeeGo colors, profile artwork/background, engineer portraits, attachment viewing and download. Photos precede captions; multiple photos form an album. No unsupported delivery/read indicators were added.
- Removed fullscreen and close buttons only from the Cases heading. Enlarged «Назад к карте», including its arrow; exercised return to the live map and rating roster and confirmed the usual Rating controls return there.
- Browser plugin not available; used isolated Playwright CLI. Exercised grouped messages on two dates, a three-photo album, unbroken long text, sending text plus a photo, composer clearing, and the unblurred image viewer. Test responses were intercepted; the real conversation was not modified. All six fixture messages had timestamps; three author groups had three names and three avatars. Layout checks at 900, 1280, 1600 and 3180 px found no overlaps, clipped message content or horizontal scroll. Inspected light/dark screenshots; no app console errors were observed (existing map-style warnings remain).
- Production build and four rating tests passed. Thousand-engineer planning/data modeling was deliberately left for the separate discussion requested by the user.

## Full conversation width — 17.10.2026

- Removed the centered 1080 px message/composer column following the user's screenshot feedback. The chat now uses fixed 22 px side padding and the composer fills the available width; compact bubbles, grouping and avatars are preserved.
- Production build passed. Browser plugin not available; checked the rendered app via isolated Playwright CLI at 900, 1600 and 3180 px. Incoming/outgoing edge offsets stayed constant (59.39 physical px including the avatar gutter), composer width grew with the conversation to 2451.72 physical px at the widest viewport, and no horizontal overflow or clipped message content was found. Inspected the wide screenshot; no app console errors were observed.

## Decision overlay and visit-events cleanup — 17.10.2026

- Removed the separate «События визита» block and its local state from review-case chat; detailed visit data remains in the review.
- Rating dialogs now portal to the application root by default. The decision shade escapes the case panel stacking context and covers the complete viewport, sidebar and shared Rating heading. The photo viewer retains its no-blur override.
- Production build passed. Browser plugin not available; used isolated Playwright CLI at 900/1600/3180 px. Verified full viewport bounds and overlay hit-testing above sidebar and heading; checked result selection, text fields, enabled submit, Escape, Cancel, focus restoration and the photo viewer's no-blur behavior. No decisions were saved. Inspected the screenshot; no app console errors were observed.

## Composer keyboard and pinned review — 17.10.2026

- Enter submits through the existing guarded form; Shift+Enter keeps native newline insertion. IME composition and held-key repeat do not trigger sending. The textarea grows up to 128 px, then scrolls internally, and resets after sending.
- The pinned review is now a flush full-width rectangle, with a gray background/border and yellow hover/focus state. Verified matching left/right edges of the conversation at 900/1600/3180 px; checked light/dark colors and opening review details.
- Production build passed. Browser plugin not available; isolated Playwright CLI confirmed two-line input retained its newline in the submitted payload, one request on rapid repeated Enter, no empty/IME send, photo-only Enter submission, and textarea growth/reset/capping. POST responses were intercepted; no test messages were persisted. Inspected the hover screenshot; no app console errors were observed.

## Persisted decisions, client-confirmed corrections and staffing discussion — 17.10.2026

- Replaced the full review's engineer-impersonation appeal action with direct decision access (or saved-history access for a resolved case). Restored the hidden open/completed case tabs; a resolved case stays discoverable. Missing form fields produce explicit validation instead of a silently disabled save control.
- Decision transactions now retain rating snapshots before/after. Added the user's chosen client-confirmed score correction: original SQL score is immutable, effective score and confirmation evidence are stored with the review/decision, summaries and star distributions use the effective score, and the UI labels the original and confirmed values. Both API and form require a different valid score, a confirmation channel/details and explicit consent. No external client contact was sent or invented.
- Added an API/file-database regression covering validation, stale revision rejection, durable decision/history, exclusion/restoration, confirmed correction, original score retention, catalog agreement and exclusion after correction. Ratings tests 5/5; Sites tests 16/16; production build passed.
- Browser plugin not available; used Playwright against a real separately started Rating API and unique temporary SQLite files (requests were forwarded to that API, not fulfilled with fabricated save results). Saving exclusion returned HTTP 200 and changed score 4.2813 → 4.3226. Saving confirmed correction 3 → 5 returned HTTP 200 and changed score 4.2813 → 4.3438, with count unchanged. Reopening the database and reloading the UI retained the result, confirmation and original score. Read-only comparisons confirmed the main application's case IDs/statuses/revisions were untouched. Checked results at 900/1600/3180 px and inspected screenshots; no application runtime errors were observed.
- Automatic restart of the main local server was rejected by execution approval review with «blocked by policy», without further detail. The old process remains running. New API features need a BeeGo server restart; the corrected-score UI is gated on API support so the old process is not offered an unsupported action. No alternate process-killing workaround was attempted. Isolated test services are stopped using their own QA shutdown endpoint.
- Re-read the original brief PDF and expert-session transcript, current rating implementation and planning code. Recorded the clarified staffing/forecast idea, proposed placement, current clone-profile limitations and unimplemented next-stage algorithm in `docs/rating-workflow-and-planning.md`. No staffing solver, home-start generator or mileage budget was silently implemented.


## Staffing workspace and planner isolation — 17.10.2026

- Added «Рейтинг → Состав и план» with day/forecast modes, quality/pool settings, three outcome metrics, district/profile composition, confirmed start/shift/equipment detail, isolated versions, explicit save and route inspection. Tab rail stays at its fixed compact width. Styles are scoped to the staffing workspace; light/dark and reduced motion are supported.
- Day calculation uses bounded whole-crew elimination with actual-time road materialization for changed routes and independent complete-plan validation. Failed insertions do not alter the source. Quality matching excludes below-threshold candidates; manual locked performers are retained and reported as exceptions. Uncovered visits stay unassigned. Hypothetical +1 specialist results persist before/after coverage and shortages and cannot be saved as real staff.
- Forecast consumes the existing CatBoost forecast with explicit target date. Joint zone/skill demand is inferred and labeled, capacity uses observed exact-plan productivity, people with several skills count once, and available qualified profiles are used before proposing more capacity. Unobserved UPSELL capacity is shown as incomplete forecast coverage. Demand reserve does not claim emergency SLA protection.
- Browser plugin unavailable; Playwright CLI used with a real separate Rating API and unique temporary SQLite file. Verified initial day, real calculation, save, DB reopen/reload, forecast, 4.7 quality deficit, +1, version restoration, routes, back navigation, dark theme and 900/1600/3180 widths. No document overflow; tables scroll locally at narrow widths; fixed tab width remained unchanged. No app console errors; known external map-style warnings remain. Inspected day, forecast, detail, hypothetical, dark and narrow screenshots.
- Real API results: 205/205 covered by 32 engineers; source search did not establish global minimality. At quality 4.7, 89/205 covered; +1 recovered seven visits (96/205), missing profiles 19→18, selected people 13→14. Both incomplete/hypothetical save controls and API guards reject treating these as real ready composition. Saved complete version persisted after reopening the test database.
- Tests: ratings + staffing 9/9; Sites 16/16; production build passed. Added regression asserting legacy calculator dispatch and save leave the operational shift byte-for-byte unchanged. Original Orders/Shift/replanning algorithms were not changed by this implementation.
- User explicitly approved restarting the local server after the earlier automatic-review rejection. Verified PID/command, no running calculations, restarted BeeGo on 8787 and confirmed health + staffing API. Read-only before/after checks confirmed operational shift revision/current-plan IDs and review-case status/revisions unchanged. Main user data was not used for QA writes.

- Final live-server smoke check after restart: staffing inputs report 205 orders and a valid base plan; calculation is enabled without error banners, forecast renders, Orders opens its ordinary workspace and Shift opens the ordinary crew/timeline screen. Existing Shift preview lookup returned 404 when there was no preview; this was handled by the prior flow and no application exception occurred. All isolated browser sessions and QA servers were closed; the intended BeeGo server remains on 8787.


## Compact rating plan and review appeal inbox — 17.10.2026

- Restored compact map-first plan workflow with standard shared tab rail. Both map and panel planning actions open the same settings dialog; completion automatically displays assigned engineers, ratings, skills, real road geometry and numbered/timed stops. Selecting an engineer focuses their route instead of opening reviews; selecting a stop opens the map point. «Все маршруты» restores the overview. Saving is separate from inspection; detailed staffing/forecast remains behind «Анализ».
- Corrected the map's previous focus-mode behavior for this workspace: with no selected engineer, route lines were hidden. Rating plan overview now shows all route colors, while selection emphasizes the actual route. Changes are conditional to Rating; ordinary planner/Shift/replanning handlers and solvers are preserved. All-route fit runs once per explicit fit token, avoiding overriding later selected-route camera fitting.
- Python now emits actual progress stages/route-check counts; backend stores elapsed calculation time. Initial POST timing starts at the new request rather than the preceding saved scenario. One real isolated calculation returned 205/205 covered by 32 engineers in 51 seconds; UI automatically returned to the compact list/map. Total deadline remains 150 seconds, bounded elimination search 40 seconds plus a pending road check.
- Added primary appeal inbox with source/search/status/sort filters, important marks, original review/reason/visit details, direct decision/history and explicit entry into the preserved messenger. No case is auto-opened on normal entry. Persistent triage has its own table and does not increment case decision revision or rating version. New engineer/client messages restore unread state. Client-origin intake retains the client as source/first-message author; existing engineer cases keep their actual origin.
- Real isolated API/SQLite browser checks covered selecting/restoring plans, active-route and all-route map state, stops, no review-card overlap, live calculation/progress/automatic result, queue-first entry, flag/view/unview, source + search filtering, decision save without entering chat, resolved filter, returning from unchanged chat, DB reopen, light/dark and 900/1600/3180 px. Inspected route-focused, all-route, inbox, selected appeal, resolved, dark and narrow screenshots. No document overflow; narrow detail replaces list rather than squeezing both. Fixed search width after inspecting the initial inbox rendering.
- Node tests: ratings/staffing/queue 11/11, Sites 16/16; production build passed. Queue regressions cover persistence, independent flags/view state, incoming-vs-dispatcher unread semantics, no score/version/revision change and true client/engineer provenance. Test writes and decisions use only the unique temporary QA database. Known external map-font 404/style warnings remain; no app exceptions in the tested flows.

- Final activation: verified no active calculations, restarted the authorized BeeGo service on 8787 (PID 9092), checked health and live compact plan/settings/Escape, inbox-first display with enabled triage controls, and ordinary Orders. Read-only snapshots confirmed operational shift revisions/current-plan IDs and case status/revisions unchanged. Test browser and isolated API were closed; main service remains running.


## Review inbox density and action clarity — 17.10.2026

- Replaced the dispersed full-width table with bounded appeal cards. Default list width is 720 CSS px; opening an appeal extends to at most 1240 CSS px with a 520 px adjacent detail column. At narrow widths the detail replaces the list. Shared Rating tab geometry remains fixed. The messenger retains its prior full-width layout.
- Card content now groups actual engineer/applicant identity, appeal reason (up to four lines), original client review/stars (up to three lines), visit type/address/number, status/date and saved outcome. Raised the main text to 14–16 px and detail paragraphs to 15 px. Card-level read action and independent flag button remain keyboard accessible; focus moves into newly opened details and returns to the card on close.
- Detail actions explain outcomes: «Принять решение» / «Завершить разбор и сохранить результат» and «Уточнить в переписке» / messages and photos. Resolved appeals show their result and repeat-open/history actions. Existing triage APIs, scores, planning algorithms and chat behavior were not changed.
- Production build and queue regressions 2/2 passed. Browser plugin unavailable; isolated Playwright CLI forwarded Rating requests to the real QA API/temporary SQLite file. Verified search, important filter/marking, direct decision dialog + Escape retaining the appeal, preserved chat + return, dark theme and 900/1600/3180 layouts. Measured list/detail widths at default zoom: 648/1116 physical px; wide view no longer stretches content. No document/detail horizontal overflow. Inspected list, details, dark and narrow screenshots; no app errors observed, only known map warnings. No test decisions or triage writes targeted the user database.


## 2026-10-17 — состав: условия → подтверждение → маршруты

- Settings now accept both rating limits as decimal numbers/sliders (1–5). Optional ready-plan history is collapsed. The compact map panel has one labelled settings row and one map-level planning action; clicking the primary action opens settings without starting a calculation.
- The real API stores an AWAITING_CONFIRMATION proposal with no route plan. The confirmation form shows the exact named candidates, quality, skills, shifts and shortages. Confirmation rechecks source revision/hash, ratings and availability; server-owned candidate IDs constrain the exact solver. Operational Orders and Shift state remain isolated.
- Reused AssignmentBoard for Rating: browser measurements match Orders exactly (17 px name text, 46 CSS px portrait, same row height). One search successfully finds «Алексей Волков» and handles no matches. All routes use neutral gray focus mode; selecting a row reveals its timed stops and map emphasis. Analysis never opened automatically.
- Real browser + real API, temporary SQLite only: interval 4.23–4.74, all 1035 candidates, proposal 32 from 1026 rating-eligible, no routes before confirmation. After confirmation exact validation assigned 205/205 jobs to 32 approved candidates in 50,890 ms. No unapproved person appeared. Saving survived reload. Main shift/plan revisions and case status/revisions matched the read-only before/after snapshot across the authorized restart (server now PID 31316 on 8787).
- UI inspected at 900×780, 1600×1000 and 3180×1250, light and dark. Settings modal fits the viewport; inverted bounds disable selection. Full-screen layout is not entered after calculation. Parent/child entrance animations were finished before final screenshots.
- `pnpm build` passed. 32 tests passed across staffing, ratings, review-case queue, map design and Sites. Coverage includes upper/lower inclusive limits in real Python composition, manual exceptions, proposal persistence, required confirmation, stale rejection, forged candidate IDs, repeated confirmation, and operational isolation.
- Temp screenshots: beego-staffing-range.png, beego-staffing-proposal.png, beego-staffing-map.png, beego-staffing-selected.png, beego-staffing-wide.png, beego-staffing-narrow.png, beego-staffing-dark.png. External map provider retains its pre-existing road-shield warnings and occasional arrow-glyph PBF 404; no application exceptions observed.


## 2026-10-17 — компактная потребность и отдельный прогноз

- Removed the full-screen StaffingWorkspace, its stylesheet, the Analysis action and summary navigation state. Planning still shows the 32 route rows on the persistent map; settings, candidate confirmation and routing are unchanged.
- Added a hover/focus/click information icon by plan settings. It opens a small nonmodal territory summary with needed/available people and independent skill-profile shortages. Exact current results are used when source/settings/version match; changing bounds shows explicitly preliminary profile needs. Missing profile details expand within the bounded scrollable popover.
- Added «Ожидаемая нагрузка» to the Rating roster footer. It uses the real existing model target (18 August 2026), 197 expected jobs / 182–212 interval, territory demand and estimated crews/reserve. The 17 UPSELL jobs without observed productivity remain explicitly unestimated. No arbitrary-date forecast is fabricated.
- Browser with real local API, read-only interactions only: no-deficit state for all three territories at 2.88–4.51; narrowing to 4.74–5 shows deficits 10/10/9 by area and expandable skill profiles. Settings changes stayed inside the QA browser and were cleared by reload; no calculation, save or operational mutation was triggered.
- Verified hover persistence on entering the popover, click pinning, close button, keyboard Escape from within the popover, optional gap details, and removal of all full-screen analysis links. Light/dark and 900×780/1600×1000 inspected; summary 324×393 viewport px, bounded forecast 324×468 px; map/list remain visible. No application exceptions; only existing external map-style warnings.
- `pnpm build` passed; 33 tests passed across staffing, ratings, queue, map and Sites, including a new invariant that surplus people in another profile/territory cannot cancel a skill shortage.
- Temp screenshots: beego-compact-needs.png, beego-compact-forecast.png, beego-compact-shortage.png, beego-insights-dark.png, beego-insights-narrow.png.


## 2026-10-17 — фильтрация отзывов в карточке инженера

- Added two compact custom selects to the engineer review block: score groups «Все оценки», «Негативные · 1–3 ★», «Хорошие · 4–5 ★» and ordering «Сначала новые», «Сначала низкая оценка», «Сначала высокая оценка».
- Filtering and sorting run over the complete loaded review history before the visible-row limit. «Показать ещё» increases the limit for the active selection. Empty filtered results explain that no reviews match; score corrections and excluded-review labels remain intact.
- Real browser/API check on EAST-ENG-05: negative selection returned [3,3], lowest-first stayed ascending; positive selection returned 4-star entries, highest-first returned 5-star entries; more button appeared when the selected set exceeded the initial six rows. Compact and full card CSS share the controls. Build passed; existing browser warnings only.


## 2026-10-17 — анимация расчёта и портреты состава

- Replaced the static route icon during staffing selection/routing with a BeeGo loader: animated bee mark, current Russian phase, elapsed time and six-step progress (selection, input preparation, roads/windows, route check, assignment, validation). Compact header and empty list share the same loader language; reduced motion disables movement.
- Added eight generated male Russian/European-looking field-service portraits with varied apartment, office, utility, street, outdoor and workshop backgrounds. Existing primary portraits and case-specific portrait remain stable. Deterministic mapping gives reserve IDs and later primary profiles the new set.
- Existing catalogue migration now preserves 1,035 people while intentionally adding a visible low-rating tail: 90 reserve engineers below 4.2 and 33 below 4.0, making interval selection meaningful without changing operational shift data.
- Build passed; backend/module restart used the authorized local-server path, no active rating or replanning jobs were present. Shift plans and case state were read-only checked before restart.


## 2026-10-17 — расширение уникальных портретов

- Generated two additional 4×2 contact sheets (16 new images) after correcting the demographic direction: male Russian/European-looking field engineers, varied ages, facial hair, glasses and workplace backgrounds.
- Cropped the two sheets into `portrait-18.jpg` through `portrait-33.jpg`, expanding the unique generated set. The 32 available primary portraits are assigned once; the remaining three primary engineers and all reserve engineers use initials, so different engineer names never reuse a face.
- Existing primary and case portraits remain separate. Build passed after the asset/mapping update.


## 2026-10-17 — единый loader состава

- Removed the duplicate compact loading card above the route list. During staffing selection and route validation only the central loader remains.
- The bee mark is a single centered image with a restrained pulse/glow; it no longer travels back and forth. The stage title and supporting line use the same text size, redundant post-step copy is gone, and six stages use a connected progress rail with checkmarks/current highlight/upcoming circles.
- `pnpm build` passed. Existing reduced-motion behavior remains respected.


## 2026-10-17 — позиция окна потребности и заметность loader

- Anchored the territory information popover directly to the right edge of ⓘ with top alignment. Browser measurement: 12px horizontal gap, 0px vertical offset at 1600×1000.
- Enlarged the centered bee artwork and yellow glow in the single loader scene. The duplicate upper progress card remains removed.
- Build passed; browser showed the right-side popover and no second loading card.
