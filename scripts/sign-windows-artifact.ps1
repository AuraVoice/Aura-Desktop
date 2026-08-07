param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ArtifactPath,
    [string]$MetadataPath = $(if ($env:AURA_SIGNING_METADATA_PATH) { $env:AURA_SIGNING_METADATA_PATH } else { "C:\AuraSigning\metadata.json" }),
    [string]$SignToolPath = $(if ($env:AURA_SIGNING_SIGNTOOL_PATH) { $env:AURA_SIGNING_SIGNTOOL_PATH } else { "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" }),
    [string]$DlibPath = $(if ($env:AURA_SIGNING_DLIB_PATH) { $env:AURA_SIGNING_DLIB_PATH } else { "$env:LOCALAPPDATA\Microsoft\MicrosoftArtifactSigningClientTools\Azure.CodeSigning.Dlib.dll" }),
    [string]$TimestampUrl = "http://timestamp.acs.microsoft.com"
)

$ErrorActionPreference = "Stop"

# Tauri's bundler runs this with stdout and stderr captured, and reports only
# "failed to run powershell.exe" if it exits non-zero. Everything this script
# says is therefore invisible during a real bundle. When AURA_SIGNING_LOG_PATH
# is set, each line is also appended there so the workflow can dump the real
# reason after a failure instead of guessing at it.
$LogPath = $env:AURA_SIGNING_LOG_PATH

function Write-SigningLog {
    param([string]$Message)
    Write-Host $Message
    if ($LogPath) {
        Add-Content -LiteralPath $LogPath -Value $Message
    }
}

Write-SigningLog "sign-windows-artifact: cwd=$($PWD.Path)"
Write-SigningLog "sign-windows-artifact: artifact=$ArtifactPath"
Write-SigningLog "sign-windows-artifact: signtool=$SignToolPath"
Write-SigningLog "sign-windows-artifact: dlib=$DlibPath"
Write-SigningLog "sign-windows-artifact: metadata=$MetadataPath"

foreach ($requiredPath in @($ArtifactPath, $MetadataPath, $SignToolPath, $DlibPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        $missing = "Required signing file was not found: $requiredPath"
        Write-SigningLog $missing
        throw $missing
    }
}

$resolvedArtifactPath = (Resolve-Path -LiteralPath $ArtifactPath).Path

# SignTool writes its diagnostics to stderr. Merging that into the success
# stream is the only way to capture it, but under $ErrorActionPreference =
# "Stop" PowerShell turns each captured stderr line into a terminating
# ErrorRecord, which would abort before a single line could be logged. The
# preference is therefore relaxed for the duration of the call and restored
# straight after, so the exit code stays the sole judge of success.
function Invoke-SignTool {
    param([string[]]$Arguments)

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $SignToolPath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    foreach ($line in $output) {
        Write-SigningLog "$line"
    }
    return $exitCode
}

$signExitCode = Invoke-SignTool @(
    "sign",
    "/v",
    "/fd", "SHA256",
    "/tr", $TimestampUrl,
    "/td", "SHA256",
    "/dlib", $DlibPath,
    "/dmdf", $MetadataPath,
    $resolvedArtifactPath
)

if ($signExitCode -ne 0) {
    throw "Artifact Signing failed for '$resolvedArtifactPath' with exit code $signExitCode."
}

$verifyExitCode = Invoke-SignTool @("verify", "/pa", "/v", $resolvedArtifactPath)

if ($verifyExitCode -ne 0) {
    throw "Authenticode verification failed for '$resolvedArtifactPath' with exit code $verifyExitCode."
}

Write-SigningLog "Successfully signed and verified: $resolvedArtifactPath"
