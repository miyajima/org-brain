#!/usr/bin/env bash
# Update the explicitly selected Mac entry without touching its memory/settings.
set -euo pipefail
umask 077
if [ "$(uname -s)" != Darwin ]; then
  echo 'Run this script on the Mac, not in the cloud workspace.' >&2
  exit 2
fi
entry=${1:-"$HOME/.local/bin/orgbrain"}
for command in git node pnpm cargo python3; do
  command -v "$command" >/dev/null || { echo "Required command unavailable: $command (Rust >=1.89, current Node 22 LTS or 24, pnpm 10)." >&2; exit 2; }
done
test -f "$entry" || { echo "OrgBrain entry is not a file: $entry" >&2; exit 2; }
python3 - "$entry" <<'PY_CHECK'
import pathlib, re, sys
entry = pathlib.Path(sys.argv[1])
original = entry.read_text()
pattern = re.compile(r'(?m)^(exec\s+(?:/[^\s]+/)?node(?:\s+--[a-zA-Z0-9-]+)*\s+)([\"\x27]?)(/[^\n\"\x27]*orgbrain\.mjs)\2(\s+.*)$')
if not re.match(r'^#![^\n]*\bnode\b', original) and len(list(pattern.finditer(original))) != 1:
    raise SystemExit('The selected entry is an unrecognized launcher. Nothing changed; inspect its target before updating.')
PY_CHECK
stage=$(mktemp -d "${TMPDIR:-/tmp}/orgbrain-update.XXXXXX")
trap 'rm -rf "$stage"' EXIT
git clone --quiet --no-checkout --single-branch --branch main https://github.com/miyajima/org-brain.git "$stage/source"
revision=$(git -C "$stage/source" rev-parse refs/remotes/origin/main)
git -C "$stage/source" checkout --quiet --detach "$revision"
test "$(git -C "$stage/source" rev-parse HEAD)" = "$revision"
(
  cd "$stage/source"
  ASTRO_TELEMETRY_DISABLED=1 pnpm install --frozen-lockfile
  ASTRO_TELEMETRY_DISABLED=1 pnpm build:wiki
  node scripts/build-standalone.mjs packages/orgbrain-cli/dist/orgbrain.mjs
)
python3 - "$stage/source" "$entry" "$revision" <<'PY'
import datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile
source, entry, revision = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
original = entry.read_text()
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
base = pathlib.Path.home()/'.local/share/orgbrain/runtime'
destination = base/(revision+'-'+stamp)
bundle = destination/'dist/orgbrain.mjs'
# Keep shell-wrapper exports and restrictions. Never guess a dynamic launcher.
if re.match(r'^#![^\n]*\bnode\b', original):
    replacement = '#!/usr/bin/env bash\nset -euo pipefail\nexec node '+json.dumps(str(bundle))+' "$@"\n'
else:
    pattern = re.compile(r'(?m)^(exec\s+(?:/[^\s]+/)?node(?:\s+--[a-zA-Z0-9-]+)*\s+)([\"\x27]?)(/[^\n\"\x27]*orgbrain\.mjs)\2(\s+.*)$')
    matches = list(pattern.finditer(original))
    if len(matches) != 1:
        raise SystemExit('The selected entry is an unrecognized launcher. Nothing changed; inspect its target before updating.')
    match = matches[0]
    replacement = original[:match.start()]+match[1]+json.dumps(str(bundle))+match[4]+original[match.end():]
base.mkdir(parents=True, exist_ok=True)
destination.mkdir(mode=0o700)
(destination/'dist').mkdir(mode=0o700)
shutil.copy2(source/'packages/orgbrain-cli/dist/orgbrain.mjs', bundle)
for relative in ['bin','assets/wiki','skills/org-brain-wiki']:
    shutil.copytree(source/'packages/orgbrain-cli'/relative, destination/relative, dirs_exist_ok=True)
def run(args, env=None):
    return json.loads(subprocess.check_output(args, env=env, text=True, stderr=subprocess.PIPE, timeout=120))
with tempfile.TemporaryDirectory(prefix='orgbrain-mac-smoke-') as temporary:
    temp=pathlib.Path(temporary)
    env=dict(os.environ, ORGBRAIN_FEATURES_FILE=str(temp/'features.json'), ORGBRAIN_WIKI_ROOT=str(temp/'wiki'), ORGBRAIN_LOCAL_DB=str(temp/'memory.sqlite'))
    env.pop('ORGBRAIN_WIKI_ENGINE', None)
    cli=['node',str(bundle)]
    assert run(cli+['version','--json'],env)['commit'] == revision
    run(cli+['feature','llm-wiki','enable'],env)
    run(cli+['wiki','init'],env)
    docs=temp/'docs'; docs.mkdir()
    (docs/'test.md').write_text('# Mac runtime\n日本語の動作確認\n')
    assert run(cli+['wiki','ingest-folder',str(docs)],env)['imported'] == 1
    assert run(cli+['wiki','ingest-folder',str(docs)],env)['unchanged'] == 1
    assert run(cli+['wiki','search','日本語の動作確認','--scope','sources'],env)['hits']
backup=base/('backup-'+stamp)
backup.mkdir(mode=0o700)
shutil.copy2(entry,backup/'orgbrain.previous')
previous_link=os.readlink(entry) if entry.is_symlink() else None
(backup/'entry.json').write_text(json.dumps({'entry':str(entry),'previous_symlink':previous_link},indent=2)+'\n')
replacement_file=entry.with_name(entry.name+'.update-'+stamp)
replacement_file.write_text(replacement)
replacement_file.chmod(0o700)
os.replace(replacement_file,entry)
try:
    result=run([str(entry),'version','--json'])
    assert result['commit'] == revision
except Exception:
    entry.unlink()
    if previous_link is not None: entry.symlink_to(previous_link)
    else: shutil.copy2(backup/'orgbrain.previous',entry)
    raise
receipt={'entry':str(entry),'commit':revision,'backup':str(backup),'runtime':str(destination),'cli_sha256':hashlib.sha256(bundle.read_bytes()).hexdigest(),'smoke_passed':True,'memory_and_settings_changed':False}
(backup/'receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(receipt,ensure_ascii=False,indent=2))
PY
