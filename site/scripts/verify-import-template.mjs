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

const { FileBlob, SpreadsheetFile } = await loadArtifactTool();

const input = process.argv[2];
if (!input) throw new Error('Workbook path is required');
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(input));
const summary = await workbook.inspect({ kind: 'sheet,region', maxChars: 5000, tableMaxRows: 5, tableMaxCols: 18 });
console.log(summary.ndjson);
const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 },
  maxChars: 3000,
});
console.log(errors.ndjson);
