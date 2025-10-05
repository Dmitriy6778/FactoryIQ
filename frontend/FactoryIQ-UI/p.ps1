# Патчим все js в dist: ReactMajorVersion=Number(version.split(...)[0]) -> ReactMajorVersion=19
Get-ChildItem -Path .\dist -Recurse -Include *.js | ForEach-Object {
  $p = $_.FullName
  $t = Get-Content $p -Raw
  $orig = $t

  # Любая форма: version.split(...) и _react.version.split(...)
  $t = $t -replace 'var\s+ReactMajorVersion\s*=\s*Number\(\s*(?:_react\.)?version\.split\([^)]*\)\[0\]\s*\)\s*;', 'var ReactMajorVersion=19;'

  if ($t -ne $orig) {
    Set-Content -Path $p -Value $t -NoNewline
    Write-Host "Patched $p"
  }
}
