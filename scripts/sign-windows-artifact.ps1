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

# Every Windows signature, the exe then the NSIS installer then the MSI, is
# spawned through this one script, which makes it the only place that can
# guarantee a live credential at the moment signing happens. azure/login does
# not hand back a refresh token: it hands back the GitHub OIDC assertion, good
# for five minutes, and the Azure CLI replays that same string forever after.
# Bundling reaches signtool long past that, which is the AADSTS700024 failure.
# Minting a fresh assertion here means build length, step order and artifact
# count stop mattering at all.
function Update-AzureSigningLogin {
    if (-not ($env:ACTIONS_ID_TOKEN_REQUEST_URL -and $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN -and
              $env:AZURE_CLIENT_ID -and $env:AZURE_TENANT_ID)) {
        Write-SigningLog "sign-windows-artifact: login refresh skipped, not running under GitHub Actions"
        return
    }

    $tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
    $stampPath = Join-Path $tempRoot "aura-signing-login.stamp"
    if (Test-Path -LiteralPath $stampPath -PathType Leaf) {
        $ageSeconds = [int]((Get-Date) - (Get-Item -LiteralPath $stampPath).LastWriteTime).TotalSeconds
        # Artifacts signed back to back do not each need their own sign-in, and
        # skipping it also keeps two of these from writing ~/.azure at once.
        if ($ageSeconds -lt 150) {
            Write-SigningLog "sign-windows-artifact: reusing a sign-in from ${ageSeconds}s ago, still inside the five minute window"
            return
        }
    }

    $azPath = (Get-Command az.cmd -ErrorAction SilentlyContinue).Source
    if (-not $azPath) {
        $azPath = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
    }

    # az.cmd writes progress to stderr even on success, and "Stop" turns each of
    # those lines into a terminating error, so the preference is relaxed for the
    # calls themselves exactly as Invoke-SignTool does below.
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 does not reliably negotiate TLS 1.2 on its own,
        # and this script always runs under powershell.exe, never pwsh.
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $tokenUri = "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=api%3A%2F%2FAzureADTokenExchange"
        $response = Invoke-RestMethod -Method Get -Uri $tokenUri -Headers @{
            Authorization = "Bearer $($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN)"
        }
        if (-not $response.value) {
            throw "The GitHub OIDC endpoint returned no token value."
        }

        $ErrorActionPreference = "Continue"
        & $azPath login --service-principal --username $env:AZURE_CLIENT_ID --tenant $env:AZURE_TENANT_ID `
            --federated-token $response.value --output none --only-show-errors 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "az login with a fresh federated token failed with exit code $LASTEXITCODE."
        }

        # Exchanging the assertion now, rather than letting signtool do it later,
        # puts an access token good for about an hour in the CLI's own cache. The
        # assertion may die a second from now and this signature still succeeds.
        & $azPath account get-access-token --resource https://codesigning.azure.net --output none --only-show-errors 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not exchange the fresh assertion for a signing access token (exit code $LASTEXITCODE)."
        }

        Set-Content -LiteralPath $stampPath -Value (Get-Date).ToString("o") -Encoding utf8
        Write-SigningLog "sign-windows-artifact: refreshed the Azure sign-in with a newly minted OIDC assertion"
    } catch {
        # Deliberately not fatal. A sign-in from an earlier step may still be
        # usable, and signtool's own error says more about why than this would.
        Write-SigningLog "sign-windows-artifact: could not refresh the Azure sign-in ($($_.Exception.Message)). Continuing with the existing session."
    } finally {
        $ErrorActionPreference = $previousPreference
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

Update-AzureSigningLogin

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
