$ErrorActionPreference = "Stop"
$out = "$env:TEMP\resp_out3.log"
$err = "$env:TEMP\resp_err3.log"
$res = "$env:TEMP\resp_results3.txt"
$dumpFile = "$env:TEMP\resp_dump.txt"
Remove-Item $out,$err,$res,$dumpFile -ErrorAction SilentlyContinue

$p = Start-Process -FilePath python -ArgumentList @('-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8123') -WorkingDirectory 'd:\linux server docker learning' -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Start-Sleep -Seconds 5

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$widths = @(280, 320, 360, 390, 414, 480, 600, 768, 1024, 1440)

foreach ($w in $widths) {
    & $chrome --headless --disable-gpu --no-sandbox --window-size=900,1000 --virtual-time-budget=10000 --dump-dom "http://127.0.0.1:8123/static/mobile_probe.html?w=$w" 2>&1 | Out-File $dumpFile -Encoding utf8 -Force
    $raw = Get-Content $dumpFile -Raw
    if ($raw -match 'MEASURE:(.*?)</pre>') {
        "== WIDTH $w ==" | Add-Content $res
        ($Matches[1] -split '\|') | ForEach-Object { Add-Content $res $_ }
    } else {
        "== WIDTH $w == NO MEASURE FOUND" | Add-Content $res
    }
}

Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-Content $res