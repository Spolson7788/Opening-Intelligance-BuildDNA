param([string]$Nonce, [string]$RunId, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
# No real credentials in arguments, files, output or logs. Run only interactively
# after operator approval. Nonce/run ID are public domain-separation parameters.
function Get-ComparisonProof([string]$Key, [string]$ProofNonce, [string]$ProofRun) {
  if ($ProofNonce -cnotmatch '^[0-9a-f]{64}\z' -or $ProofRun -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z') { throw 'Invalid comparison parameters.' }
  if ($Key -cnotmatch '^[0-9a-f]{32}\z') { throw 'Expected the existing provider Access key ID: exactly 32 lowercase hexadecimal characters, without spaces. No value was exported.' }
  $bytes = New-Object byte[] 32
  for($i=0;$i -lt 32;$i++) { $bytes[$i]=[Convert]::ToByte($ProofNonce.Substring($i*2,2),16) }
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  try {
    $hmac.Key=$bytes
    $json=ConvertTo-Json -InputObject @('oi-storage-identity-v1','b64bf33c-a131-4ae2-b2b0-9aec16e9f77b',$ProofRun,$Key) -Compress
    return ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-','').ToLowerInvariant()
  } finally { $hmac.Dispose(); [Array]::Clear($bytes,0,$bytes.Length); $json=$null }
}
if($SelfTest) {
  $n='ab'*32; $r='33333333-3333-4333-8333-333333333333'; $fake='0123456789abcdef0123456789abcdef'
  if((Get-ComparisonProof $fake $n $r) -cne '518dfbc42fb0c8cf8d5114b262fcad80cf8e54f4d485d6a38b8088fcc71f248b') {throw 'Vector mismatch'}
  foreach($bad in @('',($fake+' '),(' '+$fake),('ab'*32),$fake.ToUpperInvariant(),($fake+"`n"))) {
    $rejected=$false;try {Get-ComparisonProof $bad $n $r | Out-Null} catch {$rejected=$true};if(!$rejected){throw 'Validation failure'}
  }
  Write-Output 'PASS: independent HMAC vector and six invalid-input cases; no clipboard access.'
  exit 0
}
$secure=$null; $plain=$null; $proof=$null; $ptr=[IntPtr]::Zero; $copied=$false
try {
  if([Console]::IsInputRedirected) {throw 'Interactive operator input required.'}
  $Host.UI.RawUI.WindowTitle='OI staging identity comparison - private operator input'
  Write-Host 'Enter only the EXISTING provider Access key ID. Do not enter the Secret access key.'
  Write-Host 'The key remains in process memory. Only a one-run comparison proof can be copied.'
  Write-Host 'Clipboard history/cloud sync may retain that proof. Never paste it into chat. Close this window after saving.'
  $secure=Read-Host 'Access key ID (hidden)' -AsSecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $proof=Get-ComparisonProof $plain $Nonce $RunId
  $plain=$null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $ptr=[IntPtr]::Zero
  $secure.Dispose();$secure=$null
  if((Read-Host 'Type COPY to copy only the comparison proof') -ceq 'COPY') {
    Set-Clipboard -Value $proof; $copied=$true
    Write-Host 'PROOF READY. Paste only into OI_STORAGE_DIAGNOSTIC_EXPECTED, Production Functions, Secret. Save it yourself.'
    Read-Host 'After saving, press Enter to replace clipboard with harmless text and close' | Out-Null
  }
} catch { Write-Host 'Stopped safely. No key value is displayed. Check the input type and approved comparison parameters.'; exit 1 }
finally {
  if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  if($secure){$secure.Dispose()}
  $plain=$null;$proof=$null
  if($copied){Set-Clipboard -Value 'OI comparison clipboard cleared'}
}
