param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ArtifactPath,
    [string]$MetadataPath = "C:\AuraSigning\metadata.json",
    [string]$SignToolPath = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe",
    [string]$DlibPath = "$env:LOCALAPPDATA\Microsoft\MicrosoftArtifactSigningClientTools\Azure.CodeSigning.Dlib.dll",
    [string]$TimestampUrl = "http://timestamp.acs.microsoft.com"
)

$ErrorActionPreference = "Stop"

foreach ($requiredPath in @($ArtifactPath, $MetadataPath, $SignToolPath, $DlibPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required signing file was not found: $requiredPath"
    }
}

$resolvedArtifactPath = (Resolve-Path -LiteralPath $ArtifactPath).Path

& $SignToolPath sign `
    /v `
    /fd SHA256 `
    /tr $TimestampUrl `
    /td SHA256 `
    /dlib $DlibPath `
    /dmdf $MetadataPath `
    $resolvedArtifactPath

if ($LASTEXITCODE -ne 0) {
    throw "Artifact Signing failed for '$resolvedArtifactPath' with exit code $LASTEXITCODE."
}
