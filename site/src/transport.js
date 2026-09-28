export const transportCode = value => {
  const text = String(value || '').trim().toLocaleUpperCase('ru-RU').replace(/Ё/g, 'Е');
  if (/PUBLIC|TRANSIT|BUS|ОБЩЕСТВ|ОБЩ\.?\s*ТРАНСПОРТ|МЕТРО/.test(text)) return 'PUBLIC_TRANSIT';
  if (/BICYCLE|BIKE|ВЕЛО/.test(text)) return 'BICYCLE';
  if (/WALK|FOOT|ПЕШ|ПЕШЕХОД/.test(text)) return 'WALKING';
  if (/\bCAR\b|AUTO|АВТО|МАШИН/.test(text)) return 'CAR';
  return 'UNKNOWN';
};

export const transportLabel = value => ({
  CAR: 'Автомобиль',
  PUBLIC_TRANSIT: 'Общ. транспорт',
  WALKING: 'Пешеход',
  BICYCLE: 'Велосипед',
  UNKNOWN: 'Транспорт не указан',
})[transportCode(value)];
