$env:PYTHONPATH = 'C:\Users\р\Desktop\аналитика\.algorithm-work\LCT2_ALGORITHM_UI_HANDOFF\src'

$python = 'C:\Users\р\Desktop\аналитика\.algorithm-work\.venv\Scripts\python.exe'
$project = 'C:\Users\р\Desktop\аналитика\.algorithm-work\LCT2_ALGORITHM_UI_HANDOFF'
$stdout = 'C:\Users\р\Desktop\аналитика\.algorithm-work\results\exact-repair-background-v3.log'
$stderr = 'C:\Users\р\Desktop\аналитика\.algorithm-work\results\exact-repair-background-v3.err.log'
$arguments = @(
    'tools\repair_exact_plan.py',
    '--dataset', 'A:\LCT2-routing\handoff\work\dataset_v21\beeline_synthetic_dataset_v2_1',
    '--scenario', 'core',
    '--input-plan', 'C:\Users\р\Desktop\аналитика\.algorithm-work\results\full-coverage-exact-aware-repaired.json',
    '--cache', 'C:\Users\р\Desktop\аналитика\.algorithm-work\results\full-coverage-route-cache.sqlite3',
    '--transit-index', 'A:\LCT2-routing\handoff\work\transit\moscow_2026-08-17.sqlite',
    '--screening-root', 'A:\LCT2-routing\handoff\work\routing\screening-local',
    '--output', 'C:\Users\р\Desktop\аналитика\.algorithm-work\results\full-coverage-exact-reordered-chain-v3.json',
    '--max-route-checks', '15001',
    '--max-displacements', '3',
    '--checks-by-depth', '1,4000,5000,6000',
    '--max-passes', '2',
    '--timeout-seconds', '60',
    '--max-attempts', '1',
    '--trust-input-validation',
    '--execute'
)

$process = Start-Process `
    -FilePath $python `
    -ArgumentList $arguments `
    -WorkingDirectory $project `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

[PSCustomObject]@{
    Pid = $process.Id
    Stdout = $stdout
    Stderr = $stderr
}
