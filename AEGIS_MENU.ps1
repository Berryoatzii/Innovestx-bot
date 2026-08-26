$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$gatewayDir = Join-Path $projectDir 'broker_gateway'
$envPath = Join-Path $gatewayDir '.env'
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'

[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Pause-Aegis {
  Write-Host ''
  [void](Read-Host 'กด Enter เพื่อกลับเมนู')
}

function Invoke-AegisScript([string]$Name) {
  $scriptPath = Join-Path $gatewayDir $Name
  if (-not (Test-Path -LiteralPath $scriptPath)) { throw "ไม่พบไฟล์ $Name" }
  & $scriptPath
}

function Show-AegisStatus {
  Write-Host ''
  Write-Host 'สถานะ AEGIS' -ForegroundColor Cyan
  Write-Host '  บัญชีเงินจริง: ล็อกอยู่ (ระบบนี้ยังไม่อนุญาต)' -ForegroundColor Yellow
  if (Test-Path -LiteralPath $envPath) {
    Write-Host '  รหัสบัญชีทดลอง: ตั้งค่าแล้ว' -ForegroundColor Green
  } else {
    Write-Host '  รหัสบัญชีทดลอง: ยังไม่ได้ตั้งค่า' -ForegroundColor Yellow
  }
  if (Test-Path -LiteralPath $pythonExe) {
    Write-Host '  Settrade SDK: ติดตั้งแล้ว' -ForegroundColor Green
  } else {
    Write-Host '  Settrade SDK: ยังไม่ได้ติดตั้ง' -ForegroundColor Yellow
  }
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    Write-Host '  ตัวเชื่อมบัญชีทดลอง: กำลังทำงาน' -ForegroundColor Green
  } else {
    Write-Host '  ตัวเชื่อมบัญชีทดลอง: ยังไม่ทำงาน' -ForegroundColor DarkYellow
  }
}

while ($true) {
  Clear-Host
  Write-Host '==================================================' -ForegroundColor DarkCyan
  Write-Host ' AEGIS หุ้นไทย — เมนูบัญชีทดลอง Settrade Sandbox' -ForegroundColor Cyan
  Write-Host '==================================================' -ForegroundColor DarkCyan
  Write-Host 'ระบบนี้ยังล็อกบัญชีเงินจริง และไม่รับรองกำไร' -ForegroundColor Yellow
  Show-AegisStatus
  Write-Host ''
  Write-Host '1  ตั้งค่ารหัสบัญชีทดลอง (ทำครั้งแรกครั้งเดียว)'
  Write-Host '2  ตรวจระบบ ดูพอร์ต และน้ำหนัก CORE/ACTIVE/REVIEW (อ่านอย่างเดียว)'
  Write-Host '3  ทดสอบวงจรคำสั่งซื้อขายใน Sandbox เท่านั้น'
  Write-Host '4  แสดงรายงานความพร้อมแบบไม่เชื่อมบัญชี'
  Write-Host '0  ปิดเมนู'
  Write-Host ''
  $choice = (Read-Host 'เลือกหมายเลข').Trim()

  try {
    switch ($choice) {
      '1' {
        Write-Host ''
        Write-Host 'กรอกเฉพาะข้อมูลจากหน้า Settrade Sandbox เท่านั้น' -ForegroundColor Yellow
        Write-Host 'Secret และ PIN จะไม่แสดงบนหน้าจอและไม่เข้า Git' -ForegroundColor Yellow
        Invoke-AegisScript 'setup_uat.ps1'
        Pause-Aegis
      }
      '2' {
        Invoke-AegisScript 'check_uat.ps1'
        Pause-Aegis
      }
      '3' {
        Write-Host ''
        Write-Host 'คำสั่งนี้ใช้เงินจำลองเท่านั้น แต่ต้องยืนยันก่อนส่งทุกครั้ง' -ForegroundColor Yellow
        Invoke-AegisScript 'run_uat_order_test.ps1'
        Pause-Aegis
      }
      '4' {
        if (-not (Test-Path -LiteralPath $pythonExe)) { throw 'ยังไม่ได้ติดตั้ง SDK กรุณาเลือกเมนู 1 ก่อน' }
        & $pythonExe (Join-Path $gatewayDir 'uat_readiness.py')
        Pause-Aegis
      }
      '0' { return }
      default {
        Write-Host 'กรุณาเลือก 0, 1, 2, 3 หรือ 4' -ForegroundColor Red
        Start-Sleep -Seconds 1
      }
    }
  } catch {
    Write-Host ''
    Write-Host "ไม่สำเร็จ: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'ยังไม่มีการปลดล็อกบัญชีเงินจริง' -ForegroundColor Yellow
    Pause-Aegis
  }
}
