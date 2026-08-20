[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$source = (Resolve-Path -LiteralPath $InputDirectory).Path
$required = @('meta-data', 'user-data')
$actual = @(Get-ChildItem -LiteralPath $source -File | ForEach-Object Name | Sort-Object)
if (($actual -join "`n") -ne (($required | Sort-Object) -join "`n")) {
    throw 'CIDATA input must contain exactly meta-data and user-data'
}

$target = [System.IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $target
[System.IO.Directory]::CreateDirectory($parent) | Out-Null
if (Test-Path -LiteralPath $target) {
    throw "Refusing to overwrite existing seed image: $target"
}

$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.VolumeName = 'CIDATA'
$image.FileSystemsToCreate = 3 # ISO9660 and Joliet
$image.Root.AddTree($source, $false)
$result = $image.CreateResultImage()

if (-not ('DevBridgeFast.ImapiStreamWriter' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace DevBridgeFast
{
    public static class ImapiStreamWriter
    {
        public static void Write(object source, string path)
        {
            IStream input = (IStream)source;
            byte[] buffer = new byte[2048];
            IntPtr readPointer = Marshal.AllocHGlobal(sizeof(int));
            try
            {
                using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    while (true)
                    {
                        Marshal.WriteInt32(readPointer, 0);
                        input.Read(buffer, buffer.Length, readPointer);
                        int read = Marshal.ReadInt32(readPointer);
                        if (read <= 0) break;
                        output.Write(buffer, 0, read);
                    }
                }
            }
            finally
            {
                Marshal.FreeHGlobal(readPointer);
            }
        }
    }
}
'@
}

try {
    [DevBridgeFast.ImapiStreamWriter]::Write($result.ImageStream, $target)
}
catch {
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    throw
}

$file = Get-Item -LiteralPath $target
[pscustomobject]@{
    Path = $file.FullName
    Bytes = $file.Length
    Volume = 'CIDATA'
    FileSystems = @('ISO9660', 'Joliet')
} | ConvertTo-Json -Compress
