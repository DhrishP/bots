# PowerShell script to set up GitHub workflow

# Create the workflow directory (PowerShell will not error if directory exists)
New-Item -ItemType Directory -Force -Path ".github\workflows"

# Create the workflow file content
$workflowContent = @'
name: Store ENV File

on:
  workflow_dispatch:
  push:
    paths:
      - '.env'
      - '.dev.vars'

jobs:
  store-env:
    uses: your-username/env-storage/.github/workflows/store-env-reusable.yml@main
    secrets:
      ENV_PAT: ${{ secrets.ENV_PAT }}
'@

# Write the content to the workflow file
$workflowContent | Out-File -FilePath ".github\workflows\store-env.yml" -Encoding UTF8 -Force

Write-Host "Workflow file created at .github\workflows\store-env.yml" 
