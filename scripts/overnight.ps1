# Overnight run on the RTX 4050 laptop, hands-off: teacher conversations for the previous model's weak spots -> drop
# failures and generate them once more -> dataset -> train (Recipe A, all rows at 4096) -> Q8_0 and bf16 GGUFs ->
# 30-scenario evals and gate samples. Runs detached, so it keeps going if Claude stops; it holds the PC awake while it runs.
# Used for v4-v6 (the version picks the brief catalog, data file, output folders and names). -Stage data stops after the
# teacher data (marker DATA_DONE) so it can be reviewed before training; -Stage train does the rest.
# usage: Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File scripts\overnight.ps1 -Version v6 -Stage data'
# progress: outputs\<version>_logs\overnight.log; ends with outputs\<version>_logs\DONE (or DATA_DONE) or FAILED.
param([string]$Version = 'v6', [ValidateSet('all', 'data', 'train')][string]$Stage = 'all')
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$logs = "$repo\outputs\$($Version)_logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$log = "$logs\overnight.log"
$gap = "data/gap/gap_$Version.jsonl"
$base = 'C:\Dev\Models\huggingface\hub\models--unsloth--Qwen3.5-0.8B\snapshots\23c69c53358a07516b5827588b3fdb12ae78fd65'
$server = 'C:\Dev\llama.cpp\b11786\bin\llama-server.exe'
$gguf = 'gguf @ https://github.com/ggml-org/llama.cpp/archive/refs/tags/b11786.zip#subdirectory=gguf-py'
$name = "travel-advisor-qwen3.5-0.8b-$Version"
$ggufDir = "models/trained-$Version-gguf"
$env:UV_PYTHON_INSTALL_DIR = 'C:\Dev\.uv\python'; $env:UV_CACHE_DIR = 'C:\Dev\.uv\cache'
# CUDA runtime DLLs for llama.cpp's ggml-cuda come from the venv's torch
$env:Path = "$repo\.venv\Lib\site-packages\torch\lib;" + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

Add-Type -Namespace Overnight -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
[Overnight.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null     # ES_CONTINUOUS | ES_SYSTEM_REQUIRED, until this script exits

function say($msg) { Add-Content -Path $log -Encoding utf8 -Value ("[{0:dd MMM HH:mm}] {1}" -f (Get-Date), $msg) }
function stop_servers { Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 3 }
function fail($msg) { say "FAILED: $msg"; stop_servers; Set-Content -Path "$logs\FAILED" -Value $msg; exit 1 }
function run($step, $argline) {                     # uv <argline>, output to <step>.out / .err
    say "start: $step"
    $p = Start-Process -FilePath 'uv' -ArgumentList $argline -WorkingDirectory $repo -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput "$logs\$step.out" -RedirectStandardError "$logs\$step.err"
    say "end: $step (exit $($p.ExitCode))"
    return $p.ExitCode
}
function serve($model, $port, $extra) {
    stop_servers
    $p = Start-Process -FilePath $server -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
        -ArgumentList (@('-m', $model, '-ngl', '99', '--jinja', '--host', '127.0.0.1', '--port', "$port", '--no-webui') + $extra) `
        -RedirectStandardOutput "$logs\server_$port.out" -RedirectStandardError "$logs\server_$port.err"
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep 2
        try { if ((Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2).status -eq 'ok') { return } } catch {}
    }
    fail "llama-server did not start for $model"
}

say "$Version overnight started (stage $Stage)"
if ($Stage -ne 'train') {
    # 1. teacher data: every brief in this version's catalog, then drop the failures and generate those once more
    serve 'models/teacher-Qwen3.5-4B-GGUF/Qwen3.5-4B-Q6_K.gguf' 8081 @('-c', '49152', '-np', '3')
    foreach ($round in 1, 2) {
        run "gen$round" "run --quiet python -I -m travel.simulate http://127.0.0.1:8081 $gap --catalog $Version --workers 3" | Out-Null
        run "clean$round" "run --quiet python -I scripts/keep_clean.py $gap" | Out-Null
        say ("round {0}: {1}" -f $round, (Get-Content "$logs\clean$round.out" -Raw).Trim())
    }
    stop_servers
    if ($Stage -eq 'data') { say 'DATA_DONE'; Set-Content -Path "$logs\DATA_DONE" -Value (Get-Date); exit 0 }
}

# 2. dataset (earlier gap data unchanged, plus this version's file)
if ((run 'dataset' 'run --quiet python -I -m travel.build_dataset') -ne 0) { fail 'build_dataset' }
Copy-Item reports\dataset.md "$logs\dataset.md"

# 3. train: Recipe A on the new data
if (Test-Path "outputs\$Version") { fail "outputs\$Version already exists" }
if ((run 'train' "run python train/train_lora.py outputs/$Version --bs 1 --pad 512 --epochs 2 --max-len 4096 --base $base") -ne 0) { fail 'training' }
if (-not (Test-Path "outputs\$Version\merged\config.json")) { fail 'no merged model' }
say ((Select-String -Path "$logs\train.out" -Pattern '^train \d+ samples|train_loss' | ForEach-Object { $_.Line }) -join ' | ')

# 4. export Q8_0 and bf16 (gguf-py from llama.cpp b11786; PyPI gguf is too old for this converter)
New-Item -ItemType Directory -Force $ggufDir | Out-Null
$env:PYTHONPATH = 'train'
foreach ($t in 'q8_0', 'bf16') {
    $tag = if ($t -eq 'q8_0') { 'Q8_0' } else { 'bf16' }
    $code = run "export_$t" "run --quiet --with `"$gguf`" python train/convert_hf_to_gguf.py outputs/$Version/merged --outtype $t --outfile $ggufDir/$name-$tag.gguf"
    if ($code -ne 0) { fail "export $t" }
}
Remove-Item Env:PYTHONPATH

# 5. evals on the GPU with the brief's server flags: 30 scenarios, then 5 samples of the gate scenarios and 20 more of S08/S13
foreach ($v in @(@('Q8_0', "$($Version)_cuda_deploy", 'q8'), @('bf16', "$($Version)_cuda_bf16_deploy", 'bf16'))) {
    serve "$ggufDir/$name-$($v[0]).gguf" 8091 @('-c', '16384', '-np', '2')
    if ((run "eval_$($v[2])" "run --quiet python -I -m travel.evaluate http://127.0.0.1:8091 eval/results/$($v[1]).json --system-file prompts/runtime_system_prompt.txt --deploy-sampling") -ne 0) { fail "eval $($v[0])" }
    run "gate_$($v[2])" "run --quiet python -I scripts/gate_samples.py http://127.0.0.1:8091 outputs/$($Version)_logs/gate_$($v[2]).json 5" | Out-Null
    run "book_$($v[2])" "run --quiet python -I scripts/gate_samples.py http://127.0.0.1:8091 outputs/$($Version)_logs/book_$($v[2]).json 20 8,13" | Out-Null
    if ($v[2] -eq 'q8') {                          # 3 samples of every eval and held-out scenario, for blind scoring
        run 'samples_q8_eval' "run --quiet python -I scripts/gate_samples.py http://127.0.0.1:8091 outputs/$($Version)_logs/samples_q8_eval.json 3 eval" | Out-Null
        run 'samples_q8_holdout' "run --quiet python -I scripts/gate_samples.py http://127.0.0.1:8091 outputs/$($Version)_logs/samples_q8_holdout.json 3 holdout" | Out-Null
    }
}
stop_servers
say 'DONE'
Set-Content -Path "$logs\DONE" -Value (Get-Date)
