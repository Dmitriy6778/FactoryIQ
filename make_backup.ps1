# Имя архива
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$archiveName = "project_backup_${timestamp}.zip"

# Папки/файлы, которые надо исключить
$excludeDirs = @('venv', '*.exe', '*.msi', 'node_modules', '.git', '.idea', '__pycache__')
$excludePatterns = @('*.zip', '*.tar', '*.tar.gz', '*.bak', '*.pyc', '*.log')

function ShouldInclude($item) {
    foreach ($exDir in $excludeDirs) {
        if ($item.FullName -like "*\$exDir*") { return $false }
    }
    foreach ($exPat in $excludePatterns) {
        if ($item.Name -like $exPat) { return $false }
    }
    return $true
}

# Собираем список файлов для архивации
$items = Get-ChildItem -Path . -Recurse -File | Where-Object { ShouldInclude $_ }

if ($items.Count -eq 0) {
    Write-Host "No files to archive. Check your project structure!" -ForegroundColor Red
    exit 1
}

# Архивируем
Compress-Archive -Path $items.FullName -DestinationPath $archiveName

Write-Host "Archive created: $archiveName" -ForegroundColor Green

# Открыть папку с архивом
Invoke-Item .
