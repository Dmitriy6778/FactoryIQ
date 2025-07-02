# make_backup_with_dirs.ps1
# Archives the project, preserving full directory structure (including empty folders)
# Excludes venv, node_modules, .git, .idea, __pycache__, *.zip, *.exe, *.msi

$excludeFolders = @("venv", "node_modules", ".git", ".idea", "__pycache__")
$excludePatterns = @("*.zip", "*.exe", "*.msi")

# Add .keep files to empty folders (so they are preserved)
Get-ChildItem -Directory -Recurse | Where-Object {
    ($_.GetFiles().Count + $_.GetDirectories().Count) -eq 0
} | ForEach-Object {
    $keepFile = Join-Path $_.FullName ".keep"
    if (!(Test-Path $keepFile)) {
        New-Item -Path $keepFile -ItemType "file" | Out-Null
    }
}

# Gather all files and folders to include
$allItems = @()

# Add folders (to keep empty ones)
Get-ChildItem -Path . -Recurse -Directory | ForEach-Object {
    $fullPath = $_.FullName
    $relPath = Resolve-Path -Path $fullPath | ForEach-Object {
        $_.Path.Substring((Get-Location).Path.Length + 1)
    }
    if ($excludeFolders -notcontains $_.Name -and ($excludeFolders | Where-Object { $fullPath -like "*\$_*" }) -eq $null) {
        $allItems += $relPath
    }
}

# Add files
Get-ChildItem -Path . -Recurse -File | ForEach-Object {
    $file = $_
    $exclude = $false
    foreach ($folder in $excludeFolders) {
        if ($file.FullName -like "*\$folder\*") { $exclude = $true; break }
    }
    foreach ($pattern in $excludePatterns) {
        if ($file.Name -like $pattern) { $exclude = $true; break }
    }
    if (-not $exclude) {
        $allItems += (Resolve-Path -Path $file.FullName | ForEach-Object {
            $_.Path.Substring((Get-Location).Path.Length + 1)
        })
    }
}

# Remove duplicates, just in case
$allItems = $allItems | Select-Object -Unique

$archiveName = "project_backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').zip"

if ($allItems.Count -eq 0) {
    Write-Host "No files or folders to archive!" -ForegroundColor Yellow
    exit
}

Compress-Archive -Path $allItems -DestinationPath $archiveName -Force

Write-Host "Archive successfully created: $archiveName" -ForegroundColor Green
Write-Host "If .keep files were added for empty folders, you can safely delete them after extracting." -ForegroundColor Gray
