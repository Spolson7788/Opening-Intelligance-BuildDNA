# reference-pages-upload.ps1 - link rendered page images to already-uploaded DRAFT PDFs via reference-upload mode=page.
# Project: ioqfdcehnhnqpnqawwvo ONLY. Run ONLY after Stephan approves: (1) migration 20261030120000 applied,
# (2) reference-upload function with page mode deployed, (3) this run (which sets REFERENCE_UPLOAD_KEY).
# The key is generated in this process, handed to the Supabase CLI through an in-memory named pipe, sent only in the
# x-oi-upload-key header, and never printed, logged, written to disk or passed on a command line.
# Order: local prechecks (no network) -> set key -> all pages of ONE PDF -> duplicate re-send -> wait for upload-run-pages\GO
# -> remaining pages, serial, >= 13 s apart (<= 277/hour). Stops on the first unexpected response; no retries.
param(
  [string]$Task2Dir = 'C:\Users\spols\Documents\Codex\2026-10-29\task-2',
  [string]$ProjectRef = 'ioqfdcehnhnqpnqawwvo',
  [switch]$PrecheckOnly,
  [int]$IntervalSeconds = 13
)
$ErrorActionPreference = 'Stop'
if ($ProjectRef -ne 'ioqfdcehnhnqpnqawwvo') { throw 'This uploader is restricted to ioqfdcehnhnqpnqawwvo.' }
if ($IntervalSeconds -lt 13) { throw 'IntervalSeconds must be >= 13 (keeps under 300/hour).' }
Set-Location $Task2Dir
$out = Join-Path $Task2Dir 'upload-run-pages'; New-Item -ItemType Directory -Force $out | Out-Null
$log = Join-Path $out 'run.log'; $res = Join-Path $out 'results.jsonl'
function L($m) { Add-Content $log ('{0} {1}' -f (Get-Date -Format s), $m); Write-Host $m }
function Hex([byte[]]$b) { ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b))).Replace('-', '').ToLower() }
$utf8 = New-Object Text.UTF8Encoding($false)

# ---------- 1. local prechecks (no network) ----------
$parents = @{}
Get-Content 'upload-run\results.jsonl' | ForEach-Object { $r = $_ | ConvertFrom-Json
  if ($r.code -eq 201) { $b = $r.body | ConvertFrom-Json; $parents[$b.sha256] = $b.storage_key } }
$text = @{}
Get-Content 'ready-manifests\reference_pages.jsonl' -Encoding UTF8 | ForEach-Object { $p = $_ | ConvertFrom-Json; $text["$($p.doc_sha256)#$($p.page_no)"] = $p }
$assets = @(Get-Content 'ready-manifests\page_assets.jsonl' | ForEach-Object { $_ | ConvertFrom-Json } | Sort-Object doc_sha256, page_no)
$bad = @(); $remapped = 0
function SafeSeg([string]$x) { $y = (($x -replace '[^A-Za-z0-9 ._-]', '') -replace '\s+', ' ').Trim(); if ($y.Length -gt 60) { $y = $y.Substring(0, 60) }; if ($y) { $y } else { 'unknown' } }
foreach ($a in $assets) {
  $k = "$($a.doc_sha256)#$($a.page_no)"; $p = $text[$k]
  if (-not $parents.ContainsKey($a.doc_sha256)) { $bad += "$k parent_not_uploaded"; continue }
  if (-not $p) { $bad += "$k no_page_text_row"; continue }
  $m = [regex]::Match($parents[$a.doc_sha256], '^reference/([^/]+)/([0-9a-f]{64})\.pdf$')
  if (-not $m.Success -or $m.Groups[2].Value -ne $a.doc_sha256) { $bad += "$k parent_key_unexpected"; continue }
  $expect = 'reference/{0}/{1}/p{2:D3}.{3}.png' -f $m.Groups[1].Value, $a.doc_sha256, [int]$a.page_no, $a.sha256
  if ($a.storage_key -ne $expect -or $p.image_key -ne $expect) {
    # The route stores PDFs under safeSegment(manufacturer) (e.g. "International Door Closers (IDC)" -> "... IDC"). A planned key is
    # remapped to the parent's STORED folder only when that is exactly the sanitised form of the planned folder; anything else stops.
    $pf = ($a.storage_key -split '/')[1]; $tail = ($a.storage_key -split '/', 3)[2]
    if ((SafeSeg $pf) -eq $m.Groups[1].Value -and $tail -eq ('{0}/p{1:D3}.{2}.png' -f $a.doc_sha256, [int]$a.page_no, $a.sha256) -and $p.image_key -eq $a.storage_key) {
      $remapped++; $a.storage_key = $expect
    } else { $bad += "$k manufacturer_folder_mismatch planned=$pf stored=$($m.Groups[1].Value)"; continue }
  }
  if ($p.image_sha256 -ne $a.sha256) { $bad += "$k image_sha_mismatch_between_manifests"; continue }
  if ($p.page_id -ne "sha256:$($a.doc_sha256)#p$($a.page_no)") { $bad += "$k page_id_format"; continue }
  if ((Hex $utf8.GetBytes([string]$p.text)) -ne $p.text_sha256) { $bad += "$k text_sha_mismatch"; continue }
  if (-not (Test-Path $a.path)) { $bad += "$k image_missing"; continue }
  if ((Hex ([IO.File]::ReadAllBytes($a.path))) -ne $a.sha256) { $bad += "$k image_file_sha_mismatch"; continue }
}
L ("precheck pages={0} parents={1} folder_remapped_to_stored={2} problems={3}" -f $assets.Count, ($assets | Select-Object -Unique doc_sha256).Count, $remapped, $bad.Count)
if ($bad.Count) { $bad | Select-Object -First 50 | ForEach-Object { L "PRECHECK $_" }; L 'FATAL precheck failed; nothing sent'; exit 2 }
if ($PrecheckOnly) { L 'precheck only: done, nothing sent'; exit 0 }

# ---------- 2. key: refuse to overwrite, generate in memory, set through a named pipe ----------
$exe = (Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Recurse -Filter supabase.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
if (-not $exe) { L 'FATAL supabase CLI binary not found (run npx supabase --version once)'; exit 3 }
$list = & $exe secrets list --project-ref $ProjectRef -o json 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { L 'FATAL cannot list secrets (CLI login?)'; exit 3 }
if ($list -match '"REFERENCE_UPLOAD_KEY"') { L 'FATAL REFERENCE_UPLOAD_KEY already exists; refusing to overwrite'; exit 3 }
$rb = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rb)
$key = ([Convert]::ToBase64String($rb)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
$pn = 'oiref' + [guid]::NewGuid().ToString('N')
$pipe = New-Object IO.Pipes.NamedPipeServerStream($pn, [IO.Pipes.PipeDirection]::Out)
$psi = New-Object Diagnostics.ProcessStartInfo $exe, "secrets set --project-ref $ProjectRef --env-file \\.\pipe\$pn"
$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$proc = [Diagnostics.Process]::Start($psi)
if (-not $pipe.WaitForConnectionAsync().Wait(120000)) { $proc.Kill(); L 'FATAL CLI did not open the pipe'; exit 3 }
$w = New-Object IO.StreamWriter($pipe); $w.Write("REFERENCE_UPLOAD_KEY=$key`n"); $w.Flush(); $pipe.WaitForPipeDrain(); $w.Dispose()
$null = $proc.StandardOutput.ReadToEnd(); $se = $proc.StandardError.ReadToEnd(); $proc.WaitForExit()
if ($proc.ExitCode -ne 0) { L ('FATAL secrets set failed: ' + ($se -replace [regex]::Escape($key), '[REDACTED]')); exit 3 }
L 'secret set (value not shown)'

# ---------- 3. upload helpers ----------
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$http = New-Object Net.Http.HttpClient; $http.Timeout = [TimeSpan]::FromMinutes(5)
$url = "https://$ProjectRef.supabase.co/functions/v1/reference-upload"
function Up($a) {
  $p = $text["$($a.doc_sha256)#$($a.page_no)"]
  $meta = [ordered]@{ doc_sha256 = $a.doc_sha256; page_no = [int]$a.page_no; page_id = $p.page_id; text = [string]$p.text; text_sha256 = $p.text_sha256
    page_class = $p.page_class; image_sha256 = $a.sha256; image_key = $a.storage_key }
  $req = New-Object Net.Http.HttpRequestMessage 'POST', $url
  $req.Headers.Add('x-oi-upload-key', $key)
  $mp = New-Object Net.Http.MultipartFormDataContent
  $mp.Add((New-Object Net.Http.StringContent('page')), 'mode')
  $fc = New-Object Net.Http.ByteArrayContent(, [IO.File]::ReadAllBytes($a.path)); $fc.Headers.ContentType = 'image/png'
  $mp.Add($fc, 'file', [IO.Path]::GetFileName($a.path))
  $mp.Add((New-Object Net.Http.StringContent(($meta | ConvertTo-Json -Depth 5 -Compress), $utf8, 'application/json')), 'metadata')
  $req.Content = $mp
  $resp = $http.SendAsync($req).Result
  [pscustomobject]@{ code = [int]$resp.StatusCode; body = $resp.Content.ReadAsStringAsync().Result }
}
function Rec($a, $o, $phase) { Add-Content $res (@{ phase = $phase; doc = $a.doc_sha256; page = $a.page_no; code = $o.code; body = $o.body; at = (Get-Date -Format s) } | ConvertTo-Json -Compress) }
function Ok201($a, $o) {
  if ($o.code -ne 201) { return $false }
  $j = $o.body | ConvertFrom-Json
  return ($j.status -eq 'draft' -and $j.citable -eq $false -and $j.image_key -eq $a.storage_key -and $j.image_sha256 -eq $a.sha256 -and $j.readback_sha256 -eq $a.sha256)
}

# ---------- 4. single-PDF test, then duplicate test ----------
$firstDoc = $assets[0].doc_sha256
$test = @($assets | Where-Object { $_.doc_sha256 -eq $firstDoc }); $rest = @($assets | Where-Object { $_.doc_sha256 -ne $firstDoc })
$n = 0; $dup = 0
for ($i = 0; $i -lt $test.Count; $i++) {
  $a = $test[$i]
  if ($i -eq 0) { for ($t = 0; $t -lt 12; $t++) { $o = Up $a; if ($o.code -ne 503) { break }; L 'waiting for function to see the key (503)'; Start-Sleep 15 } }
  else { Start-Sleep $IntervalSeconds; $o = Up $a }
  Rec $a $o 'test'
  if (-not (Ok201 $a $o)) { L ("FATAL test page {0}#{1} code={2} body={3}" -f $a.doc_sha256, $a.page_no, $o.code, $o.body); exit 4 }
  $n++; L ("test page {0} ok" -f $a.page_no)
}
Start-Sleep $IntervalSeconds
$o = Up $test[0]; Rec $test[0] $o 'dupe-test'
if ($o.code -ne 409 -or ($o.body | ConvertFrom-Json).error -ne 'duplicate') { L ("FATAL duplicate test code={0} body={1}" -f $o.code, $o.body); exit 5 }
L "test PDF linked ($n pages) and duplicate re-send rejected. WAITING for $out\GO (create it after verifying in the database; create ABORT to stop)"
while (-not (Test-Path (Join-Path $out 'GO'))) { if (Test-Path (Join-Path $out 'ABORT')) { L 'aborted before bulk'; exit 7 }; Start-Sleep 10 }

# ---------- 5. the rest ----------
foreach ($a in $rest) {
  if (Test-Path (Join-Path $out 'ABORT')) { L "aborted uploaded=$n dupes=$dup"; exit 7 }
  Start-Sleep $IntervalSeconds
  $o = Up $a; Rec $a $o 'bulk'
  if (Ok201 $a $o) { $n++ }
  elseif ($o.code -eq 409 -and ($o.body | ConvertFrom-Json).error -eq 'duplicate') { $dup++ }
  else { L ("FATAL stop at {0}#{1} code={2} body={3}" -f $a.doc_sha256, $a.page_no, $o.code, $o.body); L "uploaded=$n dupes=$dup"; exit 8 }
  if (($n + $dup) % 25 -eq 0) { L "progress uploaded=$n dupes=$dup of $($assets.Count)" }
}
L "DONE uploaded=$n dupes=$dup of $($assets.Count). Remember: REFERENCE_UPLOAD_KEY is still set - unset it after approval."