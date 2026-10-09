#!/usr/bin/env bash
# Entry point of the mcpkeel GitHub Action. See action.yml for the inputs.
set -euo pipefail

mode="${MCPKEEL_MODE:-verify}"
version="${MCPKEEL_VERSION:-latest}"
lockfile="${MCPKEEL_LOCKFILE:-mcp.lock}"
fail_on="${MCPKEEL_FAIL_ON:-low}"
explain="${MCPKEEL_EXPLAIN:-false}"
probe="${MCPKEEL_PROBE:-false}"
branch="${MCPKEEL_BRANCH:-mcpkeel/update-lock}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
output="${GITHUB_OUTPUT:-/dev/null}"

# The two secrets this action is handed are kept in shell variables and taken
# out of the environment, so the MCP servers that mcpkeel starts do not inherit
# them. The API key is passed to mcpkeel alone, which does not pass it on.
token="${MCPKEEL_GITHUB_TOKEN:-}"
api_key="${MCPKEEL_ANTHROPIC_API_KEY:-}"
unset MCPKEEL_GITHUB_TOKEN MCPKEEL_ANTHROPIC_API_KEY

die() {
  echo "::error::$1"
  exit 2
}

mcpkeel() {
  # MCPKEEL_BIN points at a local build. It exists for this repository's tests.
  if [ -n "${MCPKEEL_BIN:-}" ]; then
    node "$MCPKEEL_BIN" "$@"
  else
    npx --yes "mcpkeel@${version}" "$@"
  fi
}

with_review() {
  if [ -n "$api_key" ]; then
    ANTHROPIC_API_KEY="$api_key" mcpkeel "$@"
  else
    mcpkeel "$@"
  fi
}

common=(--lockfile "$lockfile" --timeout "${MCPKEEL_TIMEOUT:-30}")
if [ -n "${MCPKEEL_CONFIG:-}" ]; then common+=(--config "$MCPKEEL_CONFIG"); fi
review=()
if [ "$explain" = "true" ]; then
  review+=(--explain)
  if [ -n "${MCPKEEL_REVIEW_MODEL:-}" ]; then review+=(--model "$MCPKEEL_REVIEW_MODEL"); fi
fi

case "$mode" in
  verify)
    # ${review[@]+...} rather than "${review[@]}": bash 3.2, still the default on
    # macOS runners, treats an empty array as unset under `set -u`.
    args=(verify "${common[@]}" --fail-on "$fail_on" --report "$summary" ${review[@]+"${review[@]}"})
    if [ "$probe" = "true" ]; then args+=(--probe); fi
    set +e
    with_review "${args[@]}"
    code=$?
    set -e
    if [ "$code" -eq 1 ]; then echo "drift=true" >>"$output"; else echo "drift=false" >>"$output"; fi
    exit "$code"
    ;;

  update-pr)
    [ -f "$lockfile" ] || die "No lockfile at $lockfile. Run 'mcpkeel init' and commit the result first."
    [ -n "$token" ] || die "update-pr needs github-token."
    before="$(mktemp)"
    body="$(mktemp)"
    report="$(mktemp)"
    cp "$lockfile" "$before"

    mcpkeel update "${common[@]}"

    if cmp -s "$before" "$lockfile"; then
      echo "drift=false" >>"$output"
      echo "Every MCP server still matches $lockfile." >>"$summary"
      exit 0
    fi
    echo "drift=true" >>"$output"

    # The report compares the two lockfiles, so no server is contacted again.
    # If the review cannot run, the report is still written, on the rules alone.
    if ! with_review diff "$before" "$lockfile" --json --report "$body" ${review[@]+"${review[@]}"} >"$report"; then
      : >"$body"
      mcpkeel diff "$before" "$lockfile" --json --report "$body" >"$report"
    fi
    title="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const n = r.changes.length;
      const parts = Object.entries(r.summary).filter(([, count]) => count > 0).map(([level, count]) => `${count} ${level}`);
      console.log(`Update mcp.lock: ${n} change${n === 1 ? "" : "s"} (${parts.join(", ")})`);
    ' "$report")"
    {
      echo
      echo "Merging this pull request accepts these definitions as the new baseline. Close it to keep the current one, and \`mcpkeel verify\` will keep reporting the difference."
      echo
      echo "Opened by [mcpkeel](https://mcpkeel.app)."
    } >>"$body"
    cat "$body" >>"$summary"

    base="${MCPKEEL_BASE:-}"
    if [ -z "$base" ]; then base="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"; fi

    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git checkout --quiet -B "$branch"
    git add -- "$lockfile"
    git commit --quiet -m "$title"

    # Every server mcpkeel started has exited by now. Only at this point is the
    # token used, and it is handed to git for this one command rather than
    # stored in the repository's config.
    server="${GITHUB_SERVER_URL:-https://github.com}"
    if git config --get-all "http.${server}/.extraheader" >/dev/null 2>&1; then
      git push --quiet --force origin "HEAD:refs/heads/${branch}"
    else
      auth="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
      git -c "http.${server}/.extraheader=AUTHORIZATION: basic ${auth}" push --quiet --force origin "HEAD:refs/heads/${branch}"
    fi

    existing="$(GH_TOKEN="$token" gh pr list --head "$branch" --base "$base" --state open --json number --jq '.[0].number // empty')"
    if [ -n "$existing" ]; then
      GH_TOKEN="$token" gh pr edit "$existing" --title "$title" --body-file "$body" >/dev/null
      url="$(GH_TOKEN="$token" gh pr view "$existing" --json url --jq .url)"
    else
      url="$(GH_TOKEN="$token" gh pr create --head "$branch" --base "$base" --title "$title" --body-file "$body")"
    fi
    echo "pull-request=${url}" >>"$output"
    echo "$url"
    ;;

  *)
    die "Unknown mode '$mode'. Use 'verify' or 'update-pr'."
    ;;
esac
