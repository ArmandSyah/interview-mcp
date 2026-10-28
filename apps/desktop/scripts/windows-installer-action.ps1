param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'uninstall')]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [Parameter(Mandatory = $true)]
    [string]$TestRoot
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'A temporary GitHub-hosted runner is necessary for installer tests.'
}
$testDirectory = [IO.Path]::GetFullPath($TestRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not (Split-Path $testDirectory -Leaf).StartsWith('interview-nsis-')) {
    throw 'The test directory must have an interview-nsis- prefix.'
}
$directoryPrefix = $testDirectory + [IO.Path]::DirectorySeparatorChar
$installerExecutable = [IO.Path]::GetFullPath($Executable)
$installationDirectory = [IO.Path]::GetFullPath($Destination)
foreach ($target in @($installerExecutable, $installationDirectory)) {
    if (-not $target.StartsWith($directoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The installer target is outside the test directory: $target"
    }
}
if (-not (Test-Path -LiteralPath $installerExecutable -PathType Leaf)) {
    throw "Cannot find the installer executable: $installerExecutable"
}

# The directory argument must be last, without quotes around its value.
$installerArguments = if ($Action -eq 'install') {
    "/S /currentuser /D=$installationDirectory"
} else {
    "/S /currentuser _?=$installationDirectory"
}
$installerProcess = Start-Process -FilePath $installerExecutable `
    -ArgumentList $installerArguments -Wait -PassThru
if ($installerProcess.ExitCode -ne 0) {
    throw "NSIS $Action expected exit 0, got $($installerProcess.ExitCode): $installerExecutable $installerArguments"
}
