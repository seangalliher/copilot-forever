# The numbers for the end of the video, from GitHub (needs `gh`, signed in).
#
#   pwsh demo/capture/stats.ps1 -Repo owner/name [-Since 2026-11-05T09:00:00Z] [-Out stats.md]
#
# Counts issues, pull requests, review comments, CI runs and elapsed time from the first issue (or -Since)
# to the last merge. Copilot usage isn't available from GitHub's API here: note your AI credits before and
# after the run and add the difference by hand.
param(
    [Parameter(Mandatory)][string]$Repo,
    [datetime]$Since,
    [string]$Out = 'stats.md'
)
$ErrorActionPreference = 'Stop'

$issues = gh issue list -R $Repo --state all --limit 500 --json number,title,state,createdAt,closedAt,labels | ConvertFrom-Json
$prs = gh pr list -R $Repo --state all --limit 500 --json number,title,state,createdAt,mergedAt,additions,deletions,changedFiles,reviews,comments | ConvertFrom-Json
if ($Since) {
    $issues = @($issues | Where-Object { [datetime]$_.createdAt -ge $Since })
    $prs = @($prs | Where-Object { [datetime]$_.createdAt -ge $Since })
}
$merged = @($prs | Where-Object mergedAt)
$runs = gh run list -R $Repo --limit 500 --json conclusion,createdAt | ConvertFrom-Json
if ($Since) { $runs = @($runs | Where-Object { [datetime]$_.createdAt -ge $Since }) }

$start = if ($Since) { $Since } elseif ($issues) { ($issues | ForEach-Object { [datetime]$_.createdAt } | Measure-Object -Minimum).Minimum } else { $null }
$end = if ($merged) { ($merged | ForEach-Object { [datetime]$_.mergedAt } | Measure-Object -Maximum).Maximum } else { $null }
$hours = if ($start -and $end) { '{0:N1}' -f ($end - $start).TotalHours } else { 'n/a' }

$lines = @(
    "# Run stats for $Repo",
    '',
    "| | |",
    "|---|---|",
    "| Issues filed | $($issues.Count) ($(@($issues | Where-Object state -eq 'CLOSED').Count) closed) |",
    "| Pull requests | $($prs.Count) ($($merged.Count) merged) |",
    "| Lines added / removed (merged PRs) | $(($merged | Measure-Object additions -Sum).Sum) / $(($merged | Measure-Object deletions -Sum).Sum) |",
    "| Files changed (merged PRs) | $(($merged | Measure-Object changedFiles -Sum).Sum) |",
    "| PR reviews and comments | $(($prs | ForEach-Object { @($_.reviews).Count + @($_.comments).Count } | Measure-Object -Sum).Sum) |",
    "| CI runs | $($runs.Count) ($(@($runs | Where-Object conclusion -eq 'success').Count) green, $(@($runs | Where-Object conclusion -eq 'failure').Count) failed) |",
    "| First issue to last merge | $hours hours |",
    "| Copilot usage | (add by hand: AI credits after minus before) |",
    '',
    'Review rounds, findings and gate runs are in the agents'' own records (the handoff file and gate receipts in the repo); add them from there.'
)
$lines | Set-Content $Out -Encoding utf8
$lines | ForEach-Object { Write-Host $_ }
Write-Host "`nsaved to $Out"
