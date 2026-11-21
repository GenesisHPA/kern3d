# Part of the Chili3d Project, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.
#
# Kern3D: which Windows driver a USB laser board (JCZ / EzCAD LMC, VID 9588 PID 9899) runs on.
#   -Action status                     prints JSON {found, driver: "winusb"|"ezcad"|"other"|"none", ...}
#   -Action install -To winusb|ezcad   switches the driver (needs administrator rights)
#
# WinUSB: a tiny driver package of our own whose INF only pulls in Windows' inbox winusb.inf
# (winusb.sys is Microsoft's), its catalog signed with a local certificate made here, trusted on
# this computer only, its private key deleted after signing (what Zadig / libwdi do). EzCAD: its
# own package already in the driver store (lmcv4u.inf → oemNN.inf). Either is forced onto the
# board with UpdateDriverForPlugAndPlayDevices; nothing is downloaded.
param(
    [ValidateSet("status", "install")] [string]$Action = "status",
    [ValidateSet("winusb", "ezcad")] [string]$To = "winusb",
    [string]$Log = ""
)
$ErrorActionPreference = "Stop"
$Vid = "9588"
$Pid_ = "9899"
$HardwareId = "USB\VID_$Vid&PID_$Pid_"
$PackageDir = Join-Path $env:ProgramData "Kern3D\winusb-jcz"
$CertSubject = "CN=Kern3D local USB driver (this computer only)"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Kern3dNewDev {
    [DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool UpdateDriverForPlugAndPlayDevices(IntPtr hwnd, string hardwareId, string infPath,
        int flags, out bool reboot);
}
"@

function Get-Board {
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -like "$HardwareId\*" -or $_.InstanceId -like "$HardwareId&*" } |
        Select-Object -First 1
}

# EzCAD's own package in the driver store (lmcv4u.inf, published as oemNN.inf)
function Get-EzcadInf {
    foreach ($f in Get-ChildItem "$env:windir\INF\oem*.inf" -ErrorAction SilentlyContinue) {
        $text = Get-Content $f.FullName -TotalCount 80 -ErrorAction SilentlyContinue
        if ((($text -match "Lmcv4u") -or ($text -match "JczProduct")) -and ($text -match "VID_$Vid&PID_$Pid_")) {
            return $f.FullName
        }
    }
    return $null
}

function Get-Status {
    $board = Get-Board
    $ezcad = Get-EzcadInf
    if ($null -eq $board) { return [ordered]@{ found = $false; driver = "none"; ezcadAvailable = ($null -ne $ezcad) } }
    $id = $board.InstanceId
    $service = (Get-PnpDeviceProperty -InstanceId $id -KeyName DEVPKEY_Device_Service -ErrorAction SilentlyContinue).Data
    $inf = (Get-PnpDeviceProperty -InstanceId $id -KeyName DEVPKEY_Device_DriverInfPath -ErrorAction SilentlyContinue).Data
    $driver = "other"
    if ($service -eq "WinUSB") { $driver = "winusb" }
    elseif ($service -eq "Lmcv4u") { $driver = "ezcad" }
    elseif ([string]::IsNullOrEmpty($service)) { $driver = "none" }
    return [ordered]@{
        found = $true; driver = $driver; service = $service; inf = $inf; status = "$($board.Status)"
        ezcadAvailable = ($null -ne $ezcad)
    }
}

function New-WinUsbPackage {
    New-Item -ItemType Directory -Force $PackageDir | Out-Null
    Get-ChildItem $PackageDir | Remove-Item -Force
    $inf = Join-Path $PackageDir "kern3d_jcz.inf"
    $date = (Get-Date).ToString("MM/dd/yyyy", [Globalization.CultureInfo]::InvariantCulture)
    $lines = @(
        '[Version]',
        'Signature = "$Windows NT$"',
        'Class = USBDevice',
        'ClassGuid = {88BAE032-5A81-49f0-BC3D-A4FF138216D6}',
        'Provider = %Provider%',
        'CatalogFile = kern3d_jcz.cat',
        "DriverVer = $date,1.0.0.0",
        'PnpLockdown = 1',
        '',
        '[Manufacturer]',
        '%Provider% = Kern3D, NTamd64, NTx86, NTarm64',
        '',
        '[Kern3D.NTamd64]',
        "%Device% = Board_Install, $HardwareId",
        '[Kern3D.NTx86]',
        "%Device% = Board_Install, $HardwareId",
        '[Kern3D.NTarm64]',
        "%Device% = Board_Install, $HardwareId",
        '',
        '[Board_Install]',
        'Include = winusb.inf',
        'Needs = WINUSB.NT',
        '',
        '[Board_Install.Services]',
        'Include = winusb.inf',
        'Needs = WINUSB.NT.Services',
        '',
        '[Board_Install.HW]',
        'AddReg = Board_AddReg',
        '',
        '[Board_AddReg]',
        'HKR,,DeviceInterfaceGUIDs,0x10000,"{6C2B1E37-5F7B-4D0A-9F43-2E0A1B9C4D21}"',
        '',
        '[Strings]',
        'Provider = "Kern3D"',
        'Device = "JCZ Laser Board (Kern3D, WinUSB)"'
    )
    Set-Content -Path $inf -Value $lines -Encoding Ascii
    $cat = Join-Path $PackageDir "kern3d_jcz.cat"
    New-FileCatalog -Path $inf -CatalogFilePath $cat -CatalogVersion 2.0 | Out-Null

    # a local code-signing certificate: trusted by this computer only, private key gone after use
    $cert = New-SelfSignedCertificate -Subject $CertSubject -Type CodeSigningCert `
        -CertStoreLocation Cert:\LocalMachine\My -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(30)
    try {
        $signed = Set-AuthenticodeSignature -FilePath $cat -Certificate $cert -HashAlgorithm SHA256
        if ($signed.Status -ne "Valid" -and $signed.Status -ne "UnknownError") { throw "catalog signing: $($signed.StatusMessage)" }
        $public = New-Object Security.Cryptography.X509Certificates.X509Certificate2(, $cert.Export("Cert"))
        foreach ($storeName in "Root", "TrustedPublisher") {
            $store = New-Object Security.Cryptography.X509Certificates.X509Store($storeName, "LocalMachine")
            $store.Open("ReadWrite")
            $store.Add($public)
            $store.Close()
        }
    } finally {
        # the key that signed it is not kept: nothing else can ever be signed with this certificate
        Remove-Item -Path "Cert:\LocalMachine\My\$($cert.Thumbprint)" -DeleteKey -ErrorAction SilentlyContinue
    }
    return $inf
}

function Install-On([string]$inf) {
    $INSTALLFLAG_FORCE = 0x1
    $reboot = $false
    if (-not [Kern3dNewDev]::UpdateDriverForPlugAndPlayDevices([IntPtr]::Zero, $HardwareId, $inf, $INSTALLFLAG_FORCE, [ref]$reboot)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw ("UpdateDriverForPlugAndPlayDevices: 0x{0:X8} {1}" -f $code, (New-Object ComponentModel.Win32Exception($code)).Message)
    }
    return $reboot
}

function Write-Result($obj) {
    $json = $obj | ConvertTo-Json -Compress
    if ($Log -ne "") { Set-Content -Path $Log -Value $json -Encoding UTF8 }
    $json
}

try {
    if ($Action -eq "status") {
        Write-Result (Get-Status)
        exit 0
    }
    if ($null -eq (Get-Board)) { throw "board not connected" }
    if ($To -eq "winusb") { $inf = New-WinUsbPackage }
    else {
        $inf = Get-EzcadInf
        if ($null -eq $inf) { throw "EzCAD's driver (lmcv4u.inf) is not installed on this computer" }
    }
    $reboot = Install-On $inf
    $s = Get-Status
    $s["reboot"] = $reboot
    $s["ok"] = ($s.driver -eq $To)
    Write-Result $s
} catch {
    Write-Result ([ordered]@{ ok = $false; error = "$($_.Exception.Message)" })
    exit 1
}
