#!/usr/bin/env python3
"""Generate a varied demand history and train CatBoost demand quantile models.

The resulting JSON is a static demo artifact.  Browser clients receive predictions,
not a Python runtime or a model binary.
"""

from __future__ import annotations

import json
import math
import csv
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'public' / 'data' / 'ml-demand-forecast.json'
TRAINING_OUTPUT = ROOT / 'public' / 'data' / 'ml-demand-training.csv'
MODEL_OUTPUT = ROOT / 'models' / 'demand-forecast-catboost.cbm'
SEED = 20260918
TRAIN_START = date(2024, 8, 19)
HISTORY_END = date(2026, 8, 17)
FORECAST_DATE = HISTORY_END + timedelta(days=1)

ZONES = {
    'Юго-восток': 1.18,
    'Восток': 0.98,
    'Югоцентр': 0.82,
}
SKILLS = {'INSTALL': 0.49, 'LOCAL': 0.31, 'EMERGENCY': 0.12, 'UPSELL': 0.08}
TIME_BANDS = {
    '08:00–10:00': 0.08,
    '10:00–12:00': 0.19,
    '12:00–14:00': 0.24,
    '14:00–16:00': 0.20,
    '16:00–18:00': 0.17,
    '18:00–20:00': 0.12,
}
WEEKDAY_EFFECT = [0.71, 0.93, 1.05, 1.08, 1.03, 0.95, 0.77]
FEATURES = [
    'weekday', 'month', 'day_of_year', 'is_holiday', 'weather_severity',
    'promo_level', 'incident_level', 'zone', 'skill', 'time_band',
    'lag_1', 'lag_7', 'lag_14', 'rolling_7', 'rolling_28',
]
CATEGORICAL = ['zone', 'skill', 'time_band']


def holidays(day: date) -> int:
    return int((day.month == 1 and day.day <= 8) or (day.month == 2 and day.day == 23) or (day.month == 3 and day.day == 8) or (day.month == 5 and day.day in (1, 9)) or (day.month == 6 and day.day == 12) or (day.month == 11 and day.day == 4))


def external_signals(days: list[date], random: np.random.Generator) -> dict[date, dict[str, float | int]]:
    result: dict[date, dict[str, float | int]] = {}
    weather = 0.0
    promo_days = 0
    incident_days = 0
    for current in days:
        weather = max(-1.4, min(2.4, weather * 0.67 + random.normal(0, 0.52)))
        if promo_days == 0 and random.random() < 0.022:
            promo_days = int(random.integers(2, 6))
        if incident_days == 0 and random.random() < 0.011:
            incident_days = int(random.integers(1, 3))
        result[current] = {
            'weather_severity': round(max(0, weather), 3),
            'promo_level': int(promo_days > 0),
            'incident_level': int(incident_days > 0),
        }
        promo_days = max(0, promo_days - 1)
        incident_days = max(0, incident_days - 1)
    return result


def make_history() -> tuple[list[dict[str, object]], dict[date, dict[str, float | int]]]:
    random = np.random.default_rng(SEED)
    days = [TRAIN_START + timedelta(days=index) for index in range((HISTORY_END - TRAIN_START).days + 2)]
    signals = external_signals(days, random)
    rows: list[dict[str, object]] = []
    zone_memory = {zone: 0.0 for zone in ZONES}
    for current in days:
        doy = current.timetuple().tm_yday
        annual = 1 + 0.095 * math.sin((doy - 24) / 365 * 2 * math.pi) + 0.045 * math.cos((doy + 47) / 365 * 2 * math.pi)
        holiday_effect = 0.54 if holidays(current) else 1
        signals_today = signals[current]
        for zone, zone_weight in ZONES.items():
            zone_memory[zone] = zone_memory[zone] * 0.58 + random.normal(0, 0.055)
            zone_effect = max(0.72, 1 + zone_memory[zone])
            for skill, skill_weight in SKILLS.items():
                skill_effect = 1.18 if skill == 'EMERGENCY' and signals_today['weather_severity'] > 1 else 1
                for time_band, band_weight in TIME_BANDS.items():
                    time_effect = 1.06 if time_band in ('10:00–12:00', '12:00–14:00') and current.weekday() < 5 else 1
                    expected = 65 * zone_weight * skill_weight * band_weight * WEEKDAY_EFFECT[current.weekday()] * annual * holiday_effect * zone_effect * skill_effect * time_effect
                    expected *= 1 + 0.07 * signals_today['weather_severity'] + 0.12 * signals_today['promo_level'] + (0.55 if skill == 'EMERGENCY' else 0.08) * signals_today['incident_level']
                    count = int(random.poisson(max(0.2, expected)))
                    rows.append({
                        'date': current.isoformat(), 'weekday': current.weekday(), 'month': current.month,
                        'day_of_year': doy, 'is_holiday': holidays(current), **signals_today,
                        'zone': zone, 'skill': skill, 'time_band': time_band, 'count': count,
                    })
    return rows, signals


def add_lags(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    per_segment: dict[tuple[str, str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        per_segment[(str(row['zone']), str(row['skill']), str(row['time_band']))].append(row)
    prepared: list[dict[str, object]] = []
    for segment_rows in per_segment.values():
        segment_rows.sort(key=lambda item: str(item['date']))
        for index, row in enumerate(segment_rows):
            values = [float(item['count']) for item in segment_rows]
            row['lag_1'] = values[index - 1] if index >= 1 else values[index]
            row['lag_7'] = values[index - 7] if index >= 7 else values[index]
            row['lag_14'] = values[index - 14] if index >= 14 else values[index]
            row['rolling_7'] = round(float(np.mean(values[max(0, index - 7):index] or [values[index]])), 3)
            row['rolling_28'] = round(float(np.mean(values[max(0, index - 28):index] or [values[index]])), 3)
            if index >= 28:
                prepared.append(row)
    return prepared


def feature_rows(rows: list[dict[str, object]]) -> list[list[object]]:
    return [[row[name] for name in FEATURES] for row in rows]


def fit_model(train: list[dict[str, object]]) -> CatBoostRegressor:
    model = CatBoostRegressor(
        iterations=250, depth=6, learning_rate=0.07, loss_function='RMSE',
        random_seed=SEED, verbose=False, thread_count=4,
    )
    model.fit(feature_rows(train), [row['count'] for row in train], cat_features=[FEATURES.index(name) for name in CATEGORICAL])
    return model


def clamp(value: float) -> int:
    return max(0, int(round(value)))


def summarize(predictions: list[dict[str, object]], key: str) -> list[dict[str, int | str]]:
    groups: dict[str, dict[str, int | str]] = {}
    for row in predictions:
        name = str(row[key])
        group = groups.setdefault(name, {'name': name, 'low': 0, 'middle': 0, 'high': 0})
        group['low'] += int(row['low'])
        group['middle'] += int(row['middle'])
        group['high'] += int(row['high'])
    return sorted(groups.values(), key=lambda item: (-int(item['middle']), str(item['name'])))


def main() -> None:
    raw, signals = make_history()
    prepared = add_lags(raw)
    TRAINING_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with TRAINING_OUTPUT.open('w', newline='', encoding='utf-8') as file:
        writer = csv.DictWriter(file, fieldnames=['date', *FEATURES, 'count'])
        writer.writeheader()
        writer.writerows({key: row[key] for key in writer.fieldnames} for row in prepared)
    cutoff = HISTORY_END - timedelta(days=89)
    train = [row for row in prepared if date.fromisoformat(str(row['date'])) < cutoff]
    test = [row for row in prepared if cutoff <= date.fromisoformat(str(row['date'])) <= HISTORY_END]
    point = fit_model(train)
    MODEL_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    point.save_model(MODEL_OUTPUT, format='cbm')
    actual = np.array([float(row['count']) for row in test])
    predicted = np.maximum(0, point.predict(feature_rows(test)))
    daily_actual: dict[str, float] = defaultdict(float)
    daily_predicted: dict[str, float] = defaultdict(float)
    for row, actual_value, predicted_value in zip(test, actual, predicted):
        daily_actual[str(row['date'])] += actual_value
        daily_predicted[str(row['date'])] += predicted_value
    residuals = [abs(daily_actual[key] - daily_predicted[key]) / max(1, daily_predicted[key]) for key in daily_actual]
    calibration = max(0.06, float(np.quantile(residuals, 0.8)))
    wape = float(sum(abs(daily_actual[key] - daily_predicted[key]) for key in daily_actual) / max(1, sum(daily_actual.values())) * 100)
    coverage = float(np.mean([abs(daily_actual[key] - daily_predicted[key]) <= daily_predicted[key] * calibration for key in daily_actual]) * 100)

    target_rows = [dict(row) for row in prepared if row['date'] == FORECAST_DATE.isoformat()]
    # Target lags must use only observations available by 17 August.
    history = [row for row in prepared if row['date'] <= HISTORY_END.isoformat()]
    history_by_segment: dict[tuple[str, str, str], list[dict[str, object]]] = defaultdict(list)
    for row in history:
        history_by_segment[(str(row['zone']), str(row['skill']), str(row['time_band']))].append(row)
    for row in target_rows:
        segment = (str(row['zone']), str(row['skill']), str(row['time_band']))
        values = [float(item['count']) for item in history_by_segment[segment]]
        row['lag_1'] = values[-1]
        row['lag_7'] = values[-7]
        row['lag_14'] = values[-14]
        row['rolling_7'] = round(float(np.mean(values[-7:])), 3)
        row['rolling_28'] = round(float(np.mean(values[-28:])), 3)
        row.update(signals[FORECAST_DATE])
    target_features = feature_rows(target_rows)
    point_values = point.predict(target_features)
    predictions = []
    for row, point_value in zip(target_rows, point_values):
        middle = clamp(float(point_value))
        lower = clamp(middle * (1 - calibration))
        upper = clamp(middle * (1 + calibration))
        predictions.append({**row, 'low': lower, 'middle': middle, 'high': upper})
    total = {name: sum(int(row[name]) for row in predictions) for name in ('low', 'middle', 'high')}
    artifact = {
        'schemaVersion': 1,
        'model': 'CatBoostRegressor',
        'modelArtifact': 'models/demand-forecast-catboost.cbm',
        'targetDate': FORECAST_DATE.isoformat(),
        'training': {
            'generatedRows': len(prepared), 'historyStart': TRAIN_START.isoformat(), 'historyEnd': HISTORY_END.isoformat(),
            'features': FEATURES, 'validationDays': 90, 'wapePercent': round(wape, 1), 'intervalCoveragePercent': round(coverage, 1), 'intervalConfidencePercent': 80,
        },
        'total': total,
        'zones': summarize(predictions, 'zone'),
        'skills': summarize(predictions, 'skill'),
        'timeBands': summarize(predictions, 'time_band'),
    }
    OUTPUT.write_text(json.dumps(artifact, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'CatBoost forecast: {artifact["targetDate"]}, {len(prepared)} generated rows, WAPE {artifact["training"]["wapePercent"]}%, {OUTPUT}')
    print(f'Training data: {TRAINING_OUTPUT}')
    print(f'Trained model: {MODEL_OUTPUT}')


if __name__ == '__main__':
    main()
