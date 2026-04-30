#!/usr/bin/env bash
# release-installable.sh — Build and push source + dist to the 'installable' branch
#
# Usage:
#   ./scripts/release-installable.sh [options]
#
# Options:
#   --no-push     Build the branch locally but don't push to remote
#   --dry-run     Show what would happen without making changes
#   --branch NAME Source branch to build from (default: master)
#   --help        Show this help message
#
# The installable branch contains the full source tree PLUS the built dist/
# directory, so git-based installs (e.g. OpenCode plugin config pointing at
# a git URL) get a working package without needing a build step.

set -euo pipefail

# --- Defaults ----------------------------------------------------------------

SOURCE_BRANCH="master"
INSTALLABLE_BRANCH="installable"
PUSH=true
DRY_RUN=false

# --- Argument parsing --------------------------------------------------------

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-push)  PUSH=false;  shift ;;
        --dry-run)  DRY_RUN=true; PUSH=false; shift ;;
        --branch)   SOURCE_BRANCH="$2"; shift 2 ;;
        --help|-h)
            sed -n '2,/^$/{
                s/^# //
                s/^#//
                p
            }' "$0"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# --- Helpers -----------------------------------------------------------------

info()  { echo "▶ $*"; }
warn()  { echo "⚠ $*" >&2; }
die()   { echo "✖ $*" >&2; exit 1; }

# --- Pre-flight checks -------------------------------------------------------

# Must be in a git repo
git rev-parse --git-dir >/dev/null 2>&1 || die "Not a git repository"

# Resolve repo root (all paths relative to it)
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Must be on the expected source branch
CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$SOURCE_BRANCH" ]]; then
    die "Must be on '$SOURCE_BRANCH' branch (currently on '$CURRENT_BRANCH')"
fi

# Working tree must be clean
if [[ -n "$(git status --porcelain)" ]]; then
    die "Working tree is dirty. Commit or stash changes first."
fi

# --- Capture source commit info -----------------------------------------------

SOURCE_SHA="$(git rev-parse --short HEAD)"
SOURCE_SHA_FULL="$(git rev-parse HEAD)"
SOURCE_MSG="$(git log -1 --format='%s')"

# --- Early no-op check (before build) ----------------------------------------
# When --no-push the local ref is the target so we check it.
# When pushing, ONLY the remote ref matters — a local-only branch must not
# prevent publishing to origin.  This avoids the scenario where a prior
# --no-push run creates a matching local ref and a subsequent push run
# falsely exits with "no changes needed".

already_built_from_sha() {
    local ref="$1"
    if git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
        local msg
        msg="$(git log -1 --format='%B' "$ref" 2>/dev/null || true)"
        if echo "$msg" | grep -qF "Source-Commit: $SOURCE_SHA_FULL"; then
            return 0
        fi
    fi
    return 1
}

if [[ "$PUSH" == true ]]; then
    # Push mode: the authoritative target is origin — only check the remote ref
    git fetch origin "$INSTALLABLE_BRANCH" 2>/dev/null || true
    if already_built_from_sha "refs/remotes/origin/$INSTALLABLE_BRANCH"; then
        info "No changes needed — origin/$INSTALLABLE_BRANCH already built from $SOURCE_SHA."
        exit 0
    fi
else
    # No-push mode: the local branch is the target
    if already_built_from_sha "refs/heads/$INSTALLABLE_BRANCH"; then
        info "No changes needed — local $INSTALLABLE_BRANCH already built from $SOURCE_SHA."
        exit 0
    fi
fi

# --- Dry-run exit point -------------------------------------------------------

if [[ "$DRY_RUN" == true ]]; then
    info "Source: $SOURCE_BRANCH ($SOURCE_SHA)"
    echo "  (dry-run) would run: npm ci"
    echo "  (dry-run) would run: npm run build"
    echo "  (dry-run) would create/update branch '$INSTALLABLE_BRANCH' in a temporary worktree"
    echo "  (dry-run) would force-add dist/ and commit"
    if [[ "$PUSH" == true ]]; then
        echo "  (dry-run) would push to origin/$INSTALLABLE_BRANCH"
    fi
    info "Dry run complete."
    exit 0
fi

# --- Build -------------------------------------------------------------------

info "Installing dependencies..."
npm ci --ignore-scripts

info "Building dist/..."
npm run build

# Verify dist was created
if [[ ! -f dist/index.js ]]; then
    die "Build did not produce dist/index.js"
fi

# --- Create / update installable branch via worktree -------------------------
# We never switch branches in the user's working directory.  Instead we create
# a temporary git worktree, do all branch manipulation there, and clean up.

WORKTREE_DIR="$(mktemp -d)"
CREATED_BRANCH=false    # Track whether we created a new local branch this run
PUSH_SUCCEEDED=false    # Track whether the push completed

cleanup() {
    if [[ -n "${WORKTREE_DIR:-}" ]] && [[ -d "$WORKTREE_DIR" ]]; then
        git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
        # Belt-and-suspenders: remove the directory if worktree remove failed
        rm -rf "$WORKTREE_DIR" 2>/dev/null || true
    fi
    # If we created the branch this run and haven't successfully finished,
    # remove it so a stale local ref doesn't block the next attempt.
    if [[ "$CREATED_BRANCH" == true ]] && [[ "$PUSH_SUCCEEDED" != true ]]; then
        if [[ "$PUSH" == true ]]; then
            # Push mode: a leftover local branch would falsely no-op next time
            git branch -D "$INSTALLABLE_BRANCH" 2>/dev/null || true
        fi
        # In --no-push mode we keep the branch even on failure — the user
        # explicitly asked for a local-only build and can inspect/retry.
    fi
}
trap cleanup EXIT

info "Preparing '$INSTALLABLE_BRANCH' branch from '$SOURCE_BRANCH' ($SOURCE_SHA)..."

if git show-ref --verify --quiet "refs/heads/$INSTALLABLE_BRANCH"; then
    # Existing branch — check it out in the worktree, then replace the entire
    # tree with the source branch snapshot.  The rm + checkout pair ensures
    # files deleted from the source branch are also removed here (a plain
    # checkout overlay would silently keep stale tracked files).
    git worktree add "$WORKTREE_DIR" "$INSTALLABLE_BRANCH"
    git -C "$WORKTREE_DIR" rm -rf .
    git -C "$WORKTREE_DIR" checkout "$SOURCE_BRANCH" -- .
else
    # New branch — create it at SOURCE_BRANCH in the worktree
    CREATED_BRANCH=true
    git worktree add -b "$INSTALLABLE_BRANCH" "$WORKTREE_DIR" "$SOURCE_BRANCH"
fi

# Copy built dist into the worktree and stage it
cp -R dist "$WORKTREE_DIR/"
git -C "$WORKTREE_DIR" add -f dist/

# Only commit if there are actual staged changes
if git -C "$WORKTREE_DIR" diff --cached --quiet; then
    info "No changes to commit — installable branch is already up to date."
else
    git -C "$WORKTREE_DIR" commit -m "chore: update installable branch from $SOURCE_BRANCH ($SOURCE_SHA)

Source: $SOURCE_MSG
Source-Commit: $SOURCE_SHA_FULL
Built from: $SOURCE_SHA on $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
fi

# --- Push ---------------------------------------------------------------------

if [[ "$PUSH" == true ]]; then
    info "Pushing '$INSTALLABLE_BRANCH' to origin..."
    git push origin "$INSTALLABLE_BRANCH" --force-with-lease
    PUSH_SUCCEEDED=true
    info "Done! Install via:"
    echo "  \"haze-opencode-dcp@git+https://github.com/hazelement/opencode-dynamic-context-pruning.git#installable\""
else
    PUSH_SUCCEEDED=true  # Intentional --no-push: keep the local branch
    info "Branch '$INSTALLABLE_BRANCH' updated locally (--no-push)."
fi

info "All done."
