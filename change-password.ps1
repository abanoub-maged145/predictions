# ============================================================
# تغيير كلمة سر الموقع — شغّله كده من فولدر predictions:
#   powershell -File change-password.ps1
# هيسألك عن كلمة السر الجديدة وينشرها على الموقع تلقائياً
# ============================================================
param([string]$NewPassword)

if (-not $NewPassword) {
  $NewPassword = Read-Host "اكتب كلمة السر الجديدة"
}
if (-not $NewPassword) { Write-Host "مفيش كلمة سر — اتلغت العملية"; exit 1 }

$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($NewPassword)))).Replace('-','').ToLower()

$config = "// كلمة السر (مخزنة كبصمة SHA-256) — للتغيير استخدم سكريبت change-password.ps1`nwindow.PASS_HASH = '$hash';`n"
[System.IO.File]::WriteAllText("$PSScriptRoot\docs\config.js", $config, (New-Object System.Text.UTF8Encoding $false))

git -C $PSScriptRoot add docs/config.js
git -C $PSScriptRoot commit -m "تغيير كلمة السر"
git -C $PSScriptRoot push

Write-Host ""
Write-Host "✅ تم! كلمة السر الجديدة هتشتغل على الموقع خلال دقيقة."
Write-Host "كل الأجهزة هتحتاج تدخل كلمة السر الجديدة أول مرة."
