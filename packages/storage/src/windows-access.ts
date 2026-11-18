import { execFileSync } from "node:child_process";
// Resolve principals by SID so localized Windows group names are irrelevant.
export function verifyWindowsAccess(root: string) {
  if (process.platform !== "win32") return;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($user,'S-1-5-18','S-1-5-32-544','S-1-3-0')
$names = @('','instance.json','control.json','control.tmp','staging','objects','lock.sqlite','dropdrop.sqlite','dropdrop.sqlite-wal','dropdrop.sqlite-shm','maintenance')
foreach ($name in $names) {
  $p = if ($name) { Join-Path $env:DROPDROP_ACL_ROOT $name } else { $env:DROPDROP_ACL_ROOT }
  if (!(Test-Path -LiteralPath $p)) { continue }
  $item = Get-Item -LiteralPath $p -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 2 }
  $acl = Get-Acl -LiteralPath $p
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { exit 2 }
  foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin $trusted) { exit 2 }
  }
}`;
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, DROPDROP_ACL_ROOT: root },
        stdio: "ignore",
        timeout: 10000,
      },
    );
  } catch {
    throw Error("实例目录及控制凭据需要当前用户专用的 Windows ACL");
  }
}
