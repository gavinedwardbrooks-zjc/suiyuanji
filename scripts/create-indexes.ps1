# ============================================================
# Suiyuanji V1.0 - Database index creation script
# Tool : Tencent CloudBase CLI  (@cloudbase/cli, command: tcb)
# Env  : <your-env-id>
#
# IMPORTANT (read before running):
#   1) Creates 4 NON-UNIQUE compound indexes ONLY.
#      - Does NOT drop existing indexes.
#      - Does NOT write / migrate / delete any business data.
#      - Does NOT backfill historical coupleId.
#   2) This script was NOT executed on this dev machine
#      (tcb is not installed, no credentials present).
#      Before running, install the CLI and log in, then verify
#      each command's exact syntax (see report).
#   3) RECOMMENDED alternative: create indexes manually in the
#      WeChat DevTools cloud console (Database -> collection ->
#      Index Management). See docs/V1_INDEX_UPLOAD_GUIDE.md.
# ============================================================
$ErrorActionPreference = "Stop"
$EnvId = "<your-env-id>"

# ---- index definitions (collection | index name | key: 1=ASC -1=DESC) ----
$indexes = @(
  [pscustomobject]@{ Collection = "wishes";        Name = "idx_openid_couple_created"; Key = '{"_openid":1,"coupleId":1,"createdAt":-1}' },
  [pscustomobject]@{ Collection = "messages";      Name = "idx_couple_created";        Key = '{"coupleId":1,"createdAt":-1}' },
  [pscustomobject]@{ Collection = "recipes";       Name = "idx_enabled_category";      Key = '{"enabled":1,"category":1}' },
  [pscustomobject]@{ Collection = "daily_records"; Name = "idx_openid_couple_date";    Key = '{"_openid":1,"coupleId":1,"date":1}' }
)

# ---- 0. preflight: tcb must exist ----
if (-not (Get-Command tcb -ErrorAction SilentlyContinue)) {
  Write-Error "tcb command not found. Install it first:  npm install -g @cloudbase/cli"
  exit 1
}

# ---- 1. login and verify environment ----
Write-Host "[1/4] Login CloudBase CLI (browser authorization) ..."
tcb login
if ($LASTEXITCODE -ne 0) { Write-Error "login failed"; exit 1 }

Write-Host "[2/4] Verify env list contains $EnvId ..."
tcb env list
Write-Host "Switching to env $EnvId ..."
tcb env use $EnvId

# ---- 2. create the 4 indexes (idempotent: "already exists" is expected) ----
Write-Host "[3/4] Creating 4 compound indexes ..."
foreach ($idx in $indexes) {
  $cmd = '{"createIndexes":"' + $idx.Collection + '","indexes":[{"name":"' + $idx.Name + '","key":' + $idx.Key + '}]}'
  Write-Host "  -> $($idx.Collection).$($idx.Name)"
  # NOTE: the exact flag for passing a command may differ by CLI version.
  # Confirm with:  tcb db nosql execute --help
  tcb db nosql execute --cmd $cmd
  Write-Host "      exit code $LASTEXITCODE"
}

# ---- 3. done ----
Write-Host "[4/4] Done. Verify the 4 indexes (all non-unique) in the cloud console."
