#!/usr/bin/env bash
# Test stand-in for curl and wget. Every non-checksum URL returns a fresh
# shell script. A checksum-looking URL returns a sha256sum line for the latest
# script. Executing either script writes the marker below.
set -euo pipefail
state="${CURL_STATE_DIR:?}"
mkdir -p "$state"
count_file="$state/count"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"

url=""
outfile=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  arg="${args[$i]}"
  case "$arg" in
    -o|--output)
      i=$((i + 1))
      outfile="${args[$i]}"
      ;;
    --output=*)
      outfile="${arg#--output=}"
      ;;
    --url)
      i=$((i + 1))
      url="${args[$i]}"
      ;;
    --url=*)
      url="${arg#--url=}"
      ;;
    http://*|https://*)
      url="$arg"
      ;;
  esac
  i=$((i + 1))
done
printf '%s\n' "$url" >> "$state/urls"

is_checksum=0
case "$url" in
  *sha256*|*SHA256*|*checksum*|*CHECKSUM*|*signature*|*sums*|*SUMS*)
    is_checksum=1
    ;;
esac

emit() {
  if [[ -n "$outfile" ]]; then
    mkdir -p "$(dirname -- "$outfile")"
    printf '%s' "$1" > "$outfile"
  else
    printf '%s' "$1"
  fi
}

if [[ "$is_checksum" -eq 0 ]]; then
  body="$(cat <<EOF
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\${INSTALLER_PROBE_DIR:?}"
printf 'UNPINNED_INSTALLER_EXECUTED variant=${count}\n' >> "\${INSTALLER_PROBE_DIR}/unpinned-installer-executed"
mkdir -p "\${HOME}/.local/bin"
for tool_name in agent fx; do
  cat > "\${HOME}/.local/bin/\${tool_name}" << 'AGENT'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\${INSTALLER_PROBE_DIR:?}"
{
  printf 'UNPINNED_INSTALLER_EXECUTED launched\n'
  if [[ -n "\${CURSOR_API_KEY:-}" || -n "\${AI_SDK_FX_CHATGPT_ACCESS_TOKEN:-}" ]]; then
    printf 'read-credential\n'
  fi
  if [[ -f "\${PWD}/workspace-sentinel" ]]; then
    printf 'read-workspace\n'
  fi
} >> "\${INSTALLER_PROBE_DIR}/unpinned-installer-executed"
AGENT
  chmod +x "\${HOME}/.local/bin/\${tool_name}"
done
EOF
)"
  printf '%s' "$body" > "$state/last-installer-body"
  emit "$body"
  exit 0
fi

if [[ ! -f "$state/last-installer-body" ]]; then
  printf 'missing-installer\n' > "$state/last-installer-body"
fi
hash="$(sha256sum "$state/last-installer-body" | awk '{print $1}')"
base="$(basename "${url%%\?*}")"
base="${base%.sha256}"
base="${base%.sha256sum}"
base="${base%.sha512}"
emit "${hash}  ${base}
"
exit 0
