Add-Type -AssemblyName Microsoft.VisualBasic
$ErrorActionPreference = "Continue"

function Send-ToTrash($path) {
  if (-not (Test-Path -LiteralPath $path)) { "SKIP (不存在): $path"; return }
  try {
    if (Test-Path -LiteralPath $path -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $path,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
      )
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $path,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
      )
    }
    $still = Test-Path -LiteralPath $path
    if ($still) { "FAIL (仍存在): $path" } else { "OK   : $path" }
  } catch {
    "ERR  : $path -> $($_.Exception.Message)"
  }
}

foreach ($p in $args) { Send-ToTrash $p }
