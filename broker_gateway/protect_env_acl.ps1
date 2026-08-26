param(
  [ValidateSet('.env', '.env.production-readonly', '.env.production-pilot')]
  [string]$EnvFileName = '.env'
)

$ErrorActionPreference = 'Stop'

$gatewayDir = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$envPath = [IO.Path]::GetFullPath((Join-Path $gatewayDir $EnvFileName))
if ([IO.Path]::GetDirectoryName($envPath) -ne $gatewayDir) {
  throw 'Refusing to change ACL outside broker_gateway.'
}
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
  throw 'Credential file does not exist.'
}

$currentAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$systemAccount = ([Security.Principal.SecurityIdentifier]'S-1-5-18').Translate([Security.Principal.NTAccount]).Value
$administrators = ([Security.Principal.SecurityIdentifier]'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value
$allowedAccounts = @($currentAccount, $systemAccount, $administrators) | Select-Object -Unique

$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($account in $allowedAccounts) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $account,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $envPath -AclObject $acl

$verified = Get-Acl -LiteralPath $envPath
if (-not $verified.AreAccessRulesProtected) {
  throw 'ACL inheritance is still enabled.'
}
if ($verified.Access | Where-Object { $_.AccessControlType -ne 'Allow' -or $_.IsInherited }) {
  throw 'Unexpected inherited or deny ACL remains.'
}
Write-Host 'Credential file ACL protected. Secret values were not displayed.' -ForegroundColor Green
