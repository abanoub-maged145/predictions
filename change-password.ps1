# ============================================================
# تغيير كلمة سر الأدمن — شغّله من فولدر predictions:
#   powershell -File change-password.ps1
# (باسوردات المستخدمين بتتدار من صفحة الإدارة جوه الموقع نفسه)
# ============================================================
param([string]$NewPassword)

if (-not $NewPassword) {
  $NewPassword = Read-Host "اكتب كلمة السر الجديدة للأدمن"
}
if (-not $NewPassword) { Write-Host "مفيش كلمة سر — اتلغت العملية"; exit 1 }

$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($NewPassword)))).Replace('-','').ToLower()

$configPath = "$PSScriptRoot\docs\config.js"
$config = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
$config = $config -replace "window\.ADMIN_HASH = '[0-9a-f]+';", "window.ADMIN_HASH = '$hash';"
[System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding $false))

git -C $PSScriptRoot add docs/config.js
git -C $PSScriptRoot commit -m "تغيير كلمة سر الأدمن"
git -C $PSScriptRoot push

Write-Host ""
Write-Host "تم! كلمة سر الأدمن الجديدة هتشتغل على الموقع خلال دقيقة."
