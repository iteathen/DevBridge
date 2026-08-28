import { createHash } from 'node:crypto';

export const WINDOWS_UNATTENDED_SEED_PROTOCOL = 'devbridge/windows-unattended-seed-v1';

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const GENERATION = 'audit-handoff-v1';

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function normalizeImage(raw) {
  const value = onlyKeys(raw, new Set(['index', 'architecture', 'defaultLanguage']), 'unattended image');
  if (!Number.isSafeInteger(value.index) || value.index < 1 || value.index > 512) throw new TypeError('unattended image index is invalid');
  if (value.architecture !== 'amd64') throw new TypeError('unattended image architecture is unsupported');
  if (typeof value.defaultLanguage !== 'string' || !LANGUAGE.test(value.defaultLanguage)) throw new TypeError('unattended image defaultLanguage is invalid');
  return { index: value.index, architecture: value.architecture, defaultLanguage: value.defaultLanguage };
}

function normalizeAccess(raw) {
  const value = onlyKeys(raw, new Set(['user', 'secret']), 'unattended access');
  if (value.user !== 'Administrator') throw new TypeError('unattended access user is unsupported');
  if (typeof value.secret !== 'string' || value.secret.length < 20 || value.secret.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.secret)
    || !/[A-Z]/u.test(value.secret) || !/[a-z]/u.test(value.secret) || !/[0-9]/u.test(value.secret) || !/[^A-Za-z0-9]/u.test(value.secret)) {
    throw new TypeError('unattended access secret is invalid');
  }
  return { user: value.user, secret: value.secret };
}

function digest(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.path, 'utf8').update('\0').update(file.content, 'utf8').update('\0');
  return hash.digest('hex');
}

function prepareScript() {
  return String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'DevBridge\ImageConstruction'
$ready = Join-Path $root 'ready-v1'
if (Test-Path -LiteralPath $ready -PathType Leaf) { exit 0 }
$null = New-Item -ItemType Directory -Path $root -Force
$pending = Join-Path $root 'ready-v1.pending'
Set-Content -LiteralPath $pending -Value 'devbridge-windows-audit-ready-v1' -Encoding utf8 -NoNewline
$process = Start-Process -FilePath 'shutdown.exe' -ArgumentList '/s', '/t', '10', '/f' -Wait -NoNewWindow -PassThru
if ($process.ExitCode -ne 0) { throw 'bounded shutdown scheduling failed' }
Move-Item -LiteralPath $pending -Destination $ready -Force
`;
}

function answerFile({ image, access }) {
  const language = xml(image.defaultLanguage);
  const secret = xml(access.secret);
  const command = xml(`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$v=@(Get-Volume -FileSystemLabel 'DB_SETUP' | Where-Object { $null -ne $_.DriveLetter }); if($v.Count -ne 1){throw 'setup media is unavailable'}; & (Join-Path (($v[0].DriveLetter)+':\\') 'Setup\\Prepare.ps1')"`);
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="${image.architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <SetupUILanguage><UILanguage>${language}</UILanguage></SetupUILanguage>
      <InputLocale>${language}</InputLocale><SystemLocale>${language}</SystemLocale><UILanguage>${language}</UILanguage><UserLocale>${language}</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="${image.architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <DiskConfiguration>
        <Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>System</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
        <WillShowUI>Never</WillShowUI>
      </DiskConfiguration>
      <ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${image.index}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo><InstallToAvailablePartition>false</InstallToAvailablePartition><WillShowUI>Never</WillShowUI></OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula><FullName>Local Operator</FullName><Organization>Local Operator</Organization></UserData>
      <DynamicUpdate><Enable>false</Enable><WillShowUI>Never</WillShowUI></DynamicUpdate>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="${image.architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><InputLocale>${language}</InputLocale><SystemLocale>${language}</SystemLocale><UILanguage>${language}</UILanguage><UserLocale>${language}</UserLocale></component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="${image.architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><ComputerName>*</ComputerName><RegisteredOwner>Local Operator</RegisteredOwner><RegisteredOrganization>Local Operator</RegisteredOrganization></component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="${image.architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><InputLocale>${language}</InputLocale><SystemLocale>${language}</SystemLocale><UILanguage>${language}</UILanguage><UserLocale>${language}</UserLocale></component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="${image.architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <UserAccounts><AdministratorPassword><Value>${secret}</Value><PlainText>true</PlainText></AdministratorPassword></UserAccounts>
      <OOBE><HideEULAPage>true</HideEULAPage><HideLocalAccountScreen>true</HideLocalAccountScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><NetworkLocation>Work</NetworkLocation><ProtectYourPC>3</ProtectYourPC></OOBE>
    </component>
    <component name="Microsoft-Windows-Deployment" processorArchitecture="${image.architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Reseal><Mode>Audit</Mode></Reseal></component>
  </settings>
  <settings pass="auditUser">
    <component name="Microsoft-Windows-Deployment" processorArchitecture="${image.architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Description>Complete bounded image setup handoff</Description><Path>${command}</Path><WillReboot>Never</WillReboot></RunSynchronousCommand></RunSynchronous></component>
  </settings>
  <cpi:offlineImage cpi:source="wim:c:/sources/install.wim#image" xmlns:cpi="urn:schemas-microsoft-com:cpi" />
</unattend>
`;
}

export function createWindowsUnattendedSeed(raw) {
  const value = onlyKeys(raw, new Set(['identity', 'image', 'access']), 'unattended seed request');
  if (typeof value.identity !== 'string' || !SUBJECT.test(value.identity)) throw new TypeError('unattended seed identity is invalid');
  const image = normalizeImage(value.image);
  const access = normalizeAccess(value.access);
  const files = Object.freeze([
    Object.freeze({ path: 'Autounattend.xml', content: answerFile({ image, access }) }),
    Object.freeze({ path: 'Setup/Prepare.ps1', content: prepareScript() }),
  ]);
  return Object.freeze({
    protocol: WINDOWS_UNATTENDED_SEED_PROTOCOL,
    files,
    evidence: Object.freeze({
      protocol: WINDOWS_UNATTENDED_SEED_PROTOCOL,
      generation: GENERATION,
      identity: value.identity,
      image: Object.freeze({ ...image }),
      sha256: digest(files),
    }),
  });
}
