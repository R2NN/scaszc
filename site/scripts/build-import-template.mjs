import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadArtifactTool() {
  try {
    return await import('@oai/artifact-tool');
  } catch (error) {
    const dependencyRoot = process.env.NODE_PATH;
    if (!dependencyRoot) throw error;
    return import(pathToFileURL(path.join(dependencyRoot, '@oai/artifact-tool/dist/artifact_tool.mjs')).href);
  }
}

const { SpreadsheetFile, Workbook } = await loadArtifactTool();

const outputDir = process.argv[2];
if (!outputDir) throw new Error('Output directory is required');
await fs.mkdir(outputDir, { recursive: true });

const FONT = 'Arial';
const HEADER_FILL = '#FFD21F';
const HEADER_TEXT = '#2B2300';
const LINE = '#E1E4E8';
const EXAMPLE_FILL = '#FFFDF4';

const ordersHeaders = [
  'job_id', 'source_job_id', 'customer_name', 'address', 'latitude', 'longitude',
  'zone_id', 'zone_name', 'district', 'window_start', 'window_end',
  'service_duration_min', 'bk_type', 'hd_type', 'required_skill', 'priority',
  'required_transport', 'required_equipment', 'phone', 'email', 'notes',
];

const ordersExamples = [
  ['JOB-0001', 'CRM-10482', 'Иван Петров', 'Москва, ул. Тверская, 12', 55.765922, 37.605461, 'MSK-CENTRE', 'Москва · Центр', 'Тверской', '2026-09-17 09:00', '2026-09-17 12:00', 90, 'INSTALL', 'GPON', 'Монтаж', 'NORMAL', 'CAR', 'ONT|INSTALL_SET', '+7 999 100-10-01', 'client1@example.ru', 'Связаться за 30 минут'],
  ['JOB-0002', 'CRM-10483', 'ООО Альфа', 'Москва, Ленинградский проспект, 62', 55.800861, 37.530803, 'MSK-NORTH', 'Москва · Север', 'Аэропорт', '2026-09-17 13:00', '2026-09-17 16:00', 60, 'REPAIR', 'DIAGNOSTICS', 'Диагностика', 'HIGH', 'ANY', 'ROUTER', '+7 999 100-10-02', 'office@example.ru', 'Проверить линию и оборудование'],
];

const ordersGuide = [
  ['job_id', 'Да', 'Уникальный идентификатор заявки', 'Текст', 'JOB-0001'],
  ['customer_name', 'Нет', 'Клиент или объект', 'Текст', 'Иван Петров'],
  ['address', 'Да*', 'Полный адрес выезда', 'Текст', 'Москва, ул. Тверская, 12'],
  ['latitude / longitude', 'Да*', 'Точные координаты объекта', 'Число', '55.765922 / 37.605461'],
  ['window_start / window_end', 'Да', 'Начало и конец клиентского окна', 'YYYY-MM-DD HH:MM', '2026-09-17 09:00'],
  ['service_duration_min', 'Да', 'Норматив работы в минутах', 'Целое число 1–1440', '90'],
  ['bk_type / hd_type', 'Желательно', 'Тип и операция работ', 'Текст или код', 'INSTALL / GPON'],
  ['required_skill', 'Желательно', 'Навык исполнителя', 'Текст', 'Монтаж'],
  ['priority', 'Нет', 'Приоритет', 'NORMAL / HIGH / EMERGENCY', 'NORMAL'],
  ['required_transport', 'Нет', 'Требование к транспорту', 'ANY / CAR / PUBLIC_TRANSIT / FOOT', 'CAR'],
  ['required_equipment', 'Нет', 'Необходимое оборудование', 'Значения через |', 'ONT|INSTALL_SET'],
  ['phone / email', 'Нет', 'Контакты клиента', 'Текст', '+7 999 100-10-01'],
  ['notes', 'Нет', 'Комментарий диспетчеру', 'Текст', 'Связаться за 30 минут'],
];

const engineersHeaders = [
  'engineer_id', 'engineer_name', 'skills', 'shift_start', 'shift_end', 'transport',
  'equipment', 'start_address', 'start_latitude', 'start_longitude', 'zone',
  'status', 'phone', 'email',
];

const engineersExamples = [
  ['ENG-0001', 'Алексей Смирнов', 'Подключение|Локальные работы', '08:00', '17:00', 'CAR', 'ROUTER|INSTALL_SET', 'Москва, ул. 8 Марта, 10', 55.799859, 37.564312, 'Москва · Центр', 'AVAILABLE', '+7 999 100-00-01', 'a.smirnov@example.ru'],
  ['ENG-0002', 'Мария Волкова', 'Аварийные работы|Диагностика', '09:00', '18:00', 'PUBLIC_TRANSIT', 'EMERGENCY_SET', 'Москва, Ленинградский проспект, 62', 55.800861, 37.530803, 'Москва · Север', 'AVAILABLE', '+7 999 100-00-02', 'm.volkova@example.ru'],
];

const engineersGuide = [
  ['engineer_id', 'Да', 'Уникальный ID инженера', 'Текст', 'ENG-0001'],
  ['engineer_name', 'Да', 'ФИО инженера', 'Текст', 'Алексей Смирнов'],
  ['skills', 'Да', 'Навыки инженера', 'Значения через |', 'Подключение|Диагностика'],
  ['shift_start / shift_end', 'Да', 'Границы рабочей смены', 'HH:MM', '08:00 / 17:00'],
  ['transport', 'Да', 'Тип транспорта', 'CAR / PUBLIC_TRANSIT / FOOT / BIKE', 'CAR'],
  ['equipment', 'Нет', 'Доступное оборудование', 'Значения через |', 'ROUTER|INSTALL_SET'],
  ['start_address', 'Нет*', 'Адрес начала смены', 'Текст', 'Москва, ул. 8 Марта, 10'],
  ['start_latitude / start_longitude', 'Нет*', 'Точные координаты начала смены', 'Число', '55.799859 / 37.564312'],
  ['zone', 'Нет', 'Зона или участок', 'Текст', 'Москва · Центр'],
  ['status', 'Нет', 'Доступность инженера', 'AVAILABLE / UNAVAILABLE', 'AVAILABLE'],
  ['phone / email', 'Нет', 'Контакты инженера', 'Текст', '+7 999 100-00-01'],
];

function styleDataSheet(sheet, headers, examples, widths) {
  const lastColumn = String.fromCharCode(64 + headers.length);
  sheet.showGridLines = false;
  sheet.tabColor = HEADER_FILL;
  sheet.getRange(`A1:${lastColumn}${examples.length + 1}`).values = [headers, ...examples];
  sheet.freezePanes.freezeRows(1);
  sheet.getRange(`A1:${lastColumn}1`).format = {
    fill: HEADER_FILL,
    font: { name: FONT, bold: true, color: HEADER_TEXT, size: 10 },
    borders: { preset: 'all', style: 'thin', color: '#D0A900' },
    verticalAlignment: 'center',
    horizontalAlignment: 'center',
    wrapText: true,
    rowHeight: 34,
  };
  sheet.getRange(`A2:${lastColumn}500`).format = {
    font: { name: FONT, size: 10, color: '#30343A' },
    borders: { insideHorizontal: { style: 'thin', color: LINE } },
    verticalAlignment: 'center',
  };
  sheet.getRange(`A2:${lastColumn}${examples.length + 1}`).format.fill = EXAMPLE_FILL;
  sheet.getRange(`A2:${lastColumn}${examples.length + 1}`).format.wrapText = true;
  widths.forEach(([range, width]) => { sheet.getRange(range).format.columnWidth = width; });
}

function addGuide(workbook, title, guideRows, note) {
  const guide = workbook.worksheets.add('Пояснения');
  guide.showGridLines = false;
  guide.tabColor = '#2B2B2B';
  guide.mergeCells('A1:E1');
  guide.getRange('A1').values = [[title]];
  guide.getRange('A1:E1').format = {
    fill: '#2B2B2B',
    font: { name: FONT, bold: true, color: '#FFFFFF', size: 16 },
    verticalAlignment: 'center',
    rowHeight: 40,
  };
  guide.getRange('A3:E3').values = [['Поле', 'Обязательное', 'Назначение', 'Формат', 'Пример']];
  guide.getRange(`A4:E${guideRows.length + 3}`).values = guideRows;
  guide.getRange('A3:E3').format = {
    fill: HEADER_FILL,
    font: { name: FONT, bold: true, color: HEADER_TEXT, size: 10 },
    borders: { preset: 'all', style: 'thin', color: '#D0A900' },
    verticalAlignment: 'center',
    horizontalAlignment: 'center',
    rowHeight: 28,
  };
  guide.getRange(`A4:E${guideRows.length + 3}`).format = {
    font: { name: FONT, size: 10, color: '#30343A' },
    borders: { insideHorizontal: { style: 'thin', color: LINE } },
    verticalAlignment: 'center',
    wrapText: true,
    rowHeight: 32,
  };
  const noteRow = guideRows.length + 6;
  guide.mergeCells(`A${noteRow}:E${noteRow}`);
  guide.getRange(`A${noteRow}`).values = [[note]];
  guide.getRange(`A${noteRow}:E${noteRow}`).format = {
    fill: '#FFF8D6',
    font: { name: FONT, color: '#5C4A08', size: 10 },
    borders: { preset: 'outside', style: 'thin', color: '#E2C75D' },
    verticalAlignment: 'center',
    wrapText: true,
    rowHeight: 50,
  };
  guide.getRange('A:A').format.columnWidth = 28;
  guide.getRange('B:B').format.columnWidth = 16;
  guide.getRange('C:C').format.columnWidth = 36;
  guide.getRange('D:D').format.columnWidth = 30;
  guide.getRange('E:E').format.columnWidth = 34;
}

function buildOrdersWorkbook() {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('Заявки');
  styleDataSheet(sheet, ordersHeaders, ordersExamples, [
    ['A:C', 18], ['D:D', 34], ['E:F', 15], ['G:I', 18], ['J:K', 21],
    ['L:L', 19], ['M:Q', 20], ['R:R', 27], ['S:T', 22], ['U:U', 32],
  ]);
  sheet.getRange('L2:L5000').dataValidation = { rule: { type: 'whole', operator: 'between', formula1: 1, formula2: 1440 } };
  sheet.getRange('P2:P5000').dataValidation = { rule: { type: 'list', values: ['NORMAL', 'HIGH', 'EMERGENCY'] } };
  sheet.getRange('Q2:Q5000').dataValidation = { rule: { type: 'list', values: ['ANY', 'CAR', 'PUBLIC_TRANSIT', 'FOOT'] } };
  addGuide(workbook, 'Шаблон импорта заявок BeeGo!', ordersGuide, 'Не меняйте названия столбцов. Удалите примеры, добавьте свои заявки и загрузите файл в разделе «Заявки». Для каждой строки нужен адрес либо пара latitude/longitude.');
  workbook.recalculate();
  return workbook;
}

function buildEngineersWorkbook() {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add('Инженеры');
  styleDataSheet(sheet, engineersHeaders, engineersExamples, [
    ['A:B', 21], ['C:C', 34], ['D:E', 16], ['F:F', 20], ['G:G', 28],
    ['H:H', 34], ['I:J', 18], ['K:N', 22],
  ]);
  sheet.getRange('F2:F5000').dataValidation = { rule: { type: 'list', values: ['CAR', 'PUBLIC_TRANSIT', 'FOOT', 'BIKE'] } };
  sheet.getRange('L2:L5000').dataValidation = { rule: { type: 'list', values: ['AVAILABLE', 'UNAVAILABLE'] } };
  addGuide(workbook, 'Шаблон импорта инженеров BeeGo!', engineersGuide, 'Не меняйте названия столбцов. Удалите примеры, добавьте инженеров и загрузите файл в разделе «Инженеры». Несколько навыков или единиц оборудования разделяйте символом |.');
  workbook.recalculate();
  return workbook;
}

const outputs = [
  { workbook: buildOrdersWorkbook(), fileName: 'beego-orders-template.xlsx', sheets: ['Заявки', 'Пояснения'] },
  { workbook: buildEngineersWorkbook(), fileName: 'beego-engineers-template.xlsx', sheets: ['Инженеры', 'Пояснения'] },
];

for (const output of outputs) {
  if (process.argv.includes('--verify')) {
    const inspection = await output.workbook.inspect({ kind: 'sheet,region', maxChars: 5000, tableMaxRows: 5, tableMaxCols: 22 });
    console.log(inspection.ndjson);
    const previewDir = path.join(outputDir, '.template-previews');
    await fs.mkdir(previewDir, { recursive: true });
    for (const sheetName of output.sheets) {
      const preview = await output.workbook.render({ sheetName, autoCrop: 'all', scale: 1, format: 'png' });
      await fs.writeFile(path.join(previewDir, `${path.parse(output.fileName).name}-${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
    }
  }
  const xlsx = await SpreadsheetFile.exportXlsx(output.workbook);
  const outputPath = path.join(outputDir, output.fileName);
  await xlsx.save(outputPath);
  console.log(outputPath);
}
