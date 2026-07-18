# ============================================================
# تغيير كلمة سر الأدمن — شغّله من فولدر predictions:
#   powershell -File change-password.ps1
# (باسوردات المستخدمين بتتدار من صفحة الإدارة جوه الموقع نفسه)
# البصمة بتتولد بصيغة PBKDF2 (310 ألف تكرار) — أقوى بكتير ضد التخمين
# ============================================================
param([string]$NewPassword)

if (-not $NewPassword) {
  $NewPassword = Read-Host "اكتب كلمة السر الجديدة للأدمن"
}
if (-not $NewPassword) { Write-Host "مفيش كلمة سر — اتلغت العملية"; exit 1 }

$iter = 310000
$saltBytes = New-Object byte[] 16
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($saltBytes)
$salt = [Convert]::ToBase64String($saltBytes)

$pbkdf2 = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
  [System.Text.Encoding]::UTF8.GetBytes($NewPassword), $saltBytes, $iter,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256)
$hash = ([System.BitConverter]::ToString($pbkdf2.GetBytes(32))).Replace('-','').ToLower()

$configPath = "$PSScriptRoot\docs\config.js"
$config = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)

# شيل سطور الأدمن القديمة (بأي صيغة) وحط الجديدة مكانها
$config = $config -replace "window\.ADMIN_SALT = '[^']*';\r?\n?", ""
$config = $config -replace "window\.ADMIN_ITER = \d+;\r?\n?", ""
$adminLines = "window.ADMIN_HASH = '$hash';`nwindow.ADMIN_SALT = '$salt';`nwindow.ADMIN_ITER = $iter;"
$config = $config -replace "window\.ADMIN_HASH = '[0-9a-f]+';", $adminLines
[System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding $false))

git -C $PSScriptRoot add docs/config.js
git -C $PSScriptRoot commit -m "تغيير كلمة سر الأدمن"
git -C $PSScriptRoot push

Write-Host ""
Write-Host "تم! كلمة سر الأدمن الجديدة هتشتغل على الموقع خلال دقيقة."
Write-Host "ملحوظة: باسوردات المستخدمين المتخزنة مشفرة هتفضل شغالة، بس مش هتظهر في وضع التعديل غير لما تكتبها تاني."
